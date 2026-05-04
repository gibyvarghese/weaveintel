/**
 * Generic agentic TaskHandler factory for live-agents.
 *
 * Wraps the package-internal `runLiveReactLoop` (Phase 2.5 scaffold in
 * `./llm/`) inside a live-agents `TaskHandler`, so any role that needs
 * an LLM-driven inner loop — Kaggle strategist, research analyst,
 * support triage, etc. — can be assembled domain-side without re-writing
 * the inbound-message → run-loop → emit-summary plumbing.
 *
 * --- LLM CALL SITE ---
 * `runLiveReactLoop(...)` inside this factory IS the only LLM invocation
 * in the live-agents runtime path. Everything else (heartbeat scheduling,
 * attention policy, action execution, message dispatch) is deterministic.
 * Domain code controls which LLM is invoked by passing the `Model` instance.
 */

import { weaveContext } from '@weaveintel/core';
import type { ExecutionContext, Model, ToolRegistry } from '@weaveintel/core';
import type { ActionExecutionContext, AttentionAction } from './types.js';
import type { TaskHandler, TaskHandlerResult } from './action-executor.js';
import { runLiveReactLoop, type LiveReactLoopResult } from './llm/index.js';
import type { ModelCapabilitySpec } from './llm/types.js';
import {
  resolveModelForTick,
  type ModelResolver,
  type ModelResolverContext,
} from './model-resolver.js';
import { hasAnyPolicyCapability, type LiveAgentPolicy } from './policy.js';
import {
  createPolicyEnforcedRegistry,
  DEFAULT_TOOL_POLICY,
  type PolicyResolutionContext,
  type ToolPolicyResolver,
} from '@weaveintel/tools';

/** The most-recent inbound TASK message for an agent, or `null` when the
 *  agent has no pending TASK in its inbox. */
export interface AgenticInboundTask {
  subject: string;
  body: string;
}

/** Per-tick preparation result. `prepare` is called once at the start of
 *  every tick so domain code can swap prompt/tools based on what's in the
 *  inbound payload (e.g. competition slug → playbook lookup). */
export interface AgenticPreparation {
  systemPrompt: string;
  tools?: ToolRegistry;
  /** Initial user-turn message for the ReAct loop. */
  userGoal: string;
}

export interface AgenticPrepareInput {
  inbound: AgenticInboundTask | null;
  context: ActionExecutionContext;
}

/** Loose shape that matches the live-agents `LiveReactLoopResult` without
 *  re-exporting the runner's deep type. Kept for backwards compatibility
 *  with handlers that destructure `{ status, steps }` directly. */
export interface AgenticRunResult {
  status: string;
  steps: ReadonlyArray<{ type: string; content?: string }>;
}

export interface AgenticTaskHandlerOptions {
  /** Display name used in agent and logs (e.g. 'kaggle-strategist'). */
  name: string;
  /**
   * Pinned model used by the ReAct loop. Domain-side decides provider/model id.
   *
   * Either `model` OR `modelResolver` (or both) MUST be provided. When both
   * are present the resolver runs first per tick; the pinned `model` is the
   * fallback when the resolver returns `undefined` or throws.
   *
   * (Was required prior to Phase 1 of the live-agents capability-parity work.)
   */
  model?: Model;
  /**
   * Per-tick model resolver — first-class capability slot mirroring how
   * `weaveAgent` accepts a pinned `model`, but called freshly on every tick
   * so domain code can rotate models based on provider health, cost ceilings,
   * capability hints, or A/B routing.
   *
   * Use `weaveModelResolver({ model })` for a pinned wrapper, or
   * `weaveModelResolverFromFn(fn)` to lift an existing routing callback.
   * For DB-backed routing, use `weaveDbModelResolver` from
   * `@weaveintel/live-agents-runtime` (Phase 2).
   */
  modelResolver?: ModelResolver;
  /** Optional logical role hint passed to `modelResolver.resolve(ctx)`.
   *  Defaults to `name`. Used by routing implementations for capability
   *  scoring. */
  role?: string;
  /** Optional capability hint passed to `modelResolver.resolve(ctx)`.
   *  Lets the handler tell routing what kind of task this tick is
   *  (e.g. `{ task: 'reasoning', toolUse: true }`). */
  modelCapability?: ModelCapabilitySpec;
  /**
   * Per-tick policy bundle — first-class capability slot mirroring how
   * `weaveAgent` accepts an `AgentPolicy`, but rebuilt fresh on every tick.
   *
   * When set, the handler wraps the per-tick `tools` registry returned
   * from `prepare()` with `createPolicyEnforcedRegistry(...)` using the
   * four primitives in {@link LiveAgentPolicy}:
   *   - `policyResolver` — gates `enabled`, `riskLevel`, `requiresApproval`
   *   - `approvalGate`   — blocks tools pending human approval
   *   - `rateLimiter`    — bounds calls per (tool, scope) per minute
   *   - `auditEmitter`   — persists every invocation outcome
   *
   * Build with `weaveLiveAgentPolicy({ ... })` from `@weaveintel/live-agents`,
   * or for DB-backed enforcement use `weaveDbLiveAgentPolicy(...)` from
   * `@weaveintel/live-agents-runtime`.
   *
   * Omit to skip policy enforcement (the registry is passed straight
   * through to the ReAct loop).
   */
  policy?: LiveAgentPolicy;
  /** Maximum tool-call loops in a single tick. Defaults to 60. */
  maxSteps?: number;
  /** Called once per tick to resolve prompt + tools + user goal. */
  prepare: (input: AgenticPrepareInput) => Promise<AgenticPreparation> | AgenticPreparation;
  /** Optional summarizer for the agent's final result. Defaults to a generic
   *  status + step-count summary. */
  summarize?: (result: AgenticRunResult) => string;
  /** Optional logger. Defaults to `console.log` with `[name]` prefix. */
  log?: (msg: string) => void;
  /** Optional error hook fired when `agent.run` throws. May rethrow, swallow,
   *  or sleep before letting the original error propagate. The default
   *  behavior is to log and rethrow. */
  onError?: (err: unknown, input: AgenticPrepareInput) => Promise<void> | void;
}

/** Read the most-recent inbound TASK message for the current agent. */
export async function loadLatestInboundTask(
  context: ActionExecutionContext,
): Promise<AgenticInboundTask | null> {
  const inbox = await context.stateStore.listMessagesForRecipient('AGENT', context.agent.id);
  const tasks = inbox
    .filter((m) => m.kind === 'TASK')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const m = tasks[0];
  return m ? { subject: m.subject, body: m.body } : null;
}

/** Permissive resolver used when a `LiveAgentPolicy` ships rate-limit /
 *  approval / audit primitives without supplying a `policyResolver` of its
 *  own. Returns the package default policy verbatim. */
const permissivePolicyResolver: ToolPolicyResolver = {
  async resolve() {
    return DEFAULT_TOOL_POLICY;
  },
};

function defaultSummarize(result: AgenticRunResult): string {  const last = [...result.steps].reverse().find((s) => s.type === 'response');
  const finalText = last?.content ?? '(no final response)';
  return [
    `status=${result.status} steps=${result.steps.length}`,
    finalText.length > 1500 ? finalText.slice(0, 1500) + '... [truncated]' : finalText,
  ].join('\n');
}

/**
 * Build a live-agents TaskHandler that, on each tick:
 *
 *   1. Loads the most-recent inbound TASK from the agent's inbox.
 *   2. Calls `prepare` to resolve the system prompt, tools, and user goal.
 *   3. Runs `weaveAgent(...).run(...)` — the LLM call site.
 *   4. Returns `{ completed: true, summaryProse }` so the action executor
 *      transitions the agent's backlog item to COMPLETED.
 *
 * The handler does NOT emit downstream messages — domain glue (e.g. Kaggle
 * `strategistAgenticWithHandoff`) wraps this handler when it needs to pass
 * the summary on to the next agent in the pipeline.
 */
export function createAgenticTaskHandler(opts: AgenticTaskHandlerOptions): TaskHandler {
  const log = opts.log ?? ((m: string) => console.log(`[${opts.name}] ${m}`));
  const maxSteps = opts.maxSteps ?? 60;
  const summarize = opts.summarize ?? defaultSummarize;

  // Eager validation so misconfigured handlers fail at registration time
  // rather than on the first tick. Either pinned `model` or `modelResolver`
  // (or both) is required.
  if (!opts.model && !opts.modelResolver) {
    throw new TypeError(
      `createAgenticTaskHandler('${opts.name}'): one of \`model\` (pinned) or ` +
        '`modelResolver` (per-tick) is required.',
    );
  }

  return async (
    _action: AttentionAction & { type: 'StartTask' | 'ContinueTask' },
    context: ActionExecutionContext,
    execCtx: ExecutionContext,
  ): Promise<TaskHandlerResult> => {
    log(`agent ${context.agent.id} starting ReAct loop (maxSteps=${maxSteps})`);

    const inbound = await loadLatestInboundTask(context);
    log(`inbound subject="${inbound?.subject ?? '(none)'}" bodyLen=${inbound?.body.length ?? 0}`);

    const prepInput: AgenticPrepareInput = { inbound, context };
    const prep = await opts.prepare(prepInput);

    // Phase 3 — wrap the per-tick tool registry with policy enforcement.
    // The wrap happens AFTER prepare() so domain code can choose its tools
    // freely; enforcement runs on whatever it returned.
    let effectiveTools = prep.tools;
    if (effectiveTools && hasAnyPolicyCapability(opts.policy)) {
      const policy = opts.policy as LiveAgentPolicy;
      // The per-call resolution context is the default plus chat/persona
      // scoping derived from the live-agents runtime so DbToolRateLimiter
      // and DbToolPolicyResolver bucket correctly.
      const resolutionContext: PolicyResolutionContext = {
        ...(policy.defaultResolutionContext ?? {}),
        chatId: context.agent.id,
        agentPersona: opts.role ?? opts.name,
      };
      try {
        effectiveTools = createPolicyEnforcedRegistry(effectiveTools, {
          // policyResolver MUST be present for createPolicyEnforcedRegistry,
          // but the runtime contract here is that any of the four primitives
          // is independently optional. We synthesize a permissive default
          // resolver only when the caller did not supply one — that way
          // audit-only / rate-limit-only policies still work.
          resolver:
            policy.policyResolver ?? permissivePolicyResolver,
          ...(policy.approvalGate ? { approvalGate: policy.approvalGate } : {}),
          ...(policy.rateLimiter ? { rateLimiter: policy.rateLimiter } : {}),
          ...(policy.auditEmitter ? { auditEmitter: policy.auditEmitter } : {}),
          resolutionContext,
        });
        log(
          `policy enforcement active (resolver=${!!policy.policyResolver} approval=${!!policy.approvalGate} rateLimit=${!!policy.rateLimiter} audit=${!!policy.auditEmitter})`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`!! failed to wrap tools with policy: ${msg}; continuing without enforcement`);
      }
    }

    // Phase 1 — resolve the model fresh per tick. The resolver runs first
    // (when configured); the pinned `opts.model` is the fallback when the
    // resolver returns `undefined` or throws.
    const resolverCtx: ModelResolverContext = {
      role: opts.role ?? opts.name,
      agentId: context.agent.id,
      meshId: context.agent.meshId,
      ...(opts.modelCapability ? { capability: opts.modelCapability } : {}),
    };
    const resolved = await resolveModelForTick(
      opts.modelResolver,
      opts.model,
      resolverCtx,
    );
    if (resolved.source === 'resolver') {
      const id =
        (resolved.model as unknown as { id?: string }).id ??
        (resolved.model as unknown as { modelId?: string }).modelId ??
        'unknown';
      log(`per-tick model resolved → ${id}`);
    } else if (resolved.error) {
      log(`per-tick model resolver failed (${resolved.error}); using pinned model`);
    }

    const ctx = execCtx ?? weaveContext({ userId: `live-agent:${context.agent.id}` });
    let loop: LiveReactLoopResult;
    try {
      // *** LLM CALL SITE — the only model.generate() in the live-agents flow ***
      loop = await runLiveReactLoop({
        name: opts.name,
        model: resolved.model,
        ...(effectiveTools ? { tools: effectiveTools } : {}),
        systemPrompt: prep.systemPrompt,
        userGoal: prep.userGoal,
        maxSteps,
        execContext: ctx,
        agentId: context.agent.id,
      });
    } catch (err) {
      // runLiveReactLoop catches its own errors, but we keep this guard
      // for any future implementation that re-introduces a throw path.
      const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      log(`!! runLiveReactLoop threw: ${msg}`);
      if (opts.onError) {
        await opts.onError(err, prepInput);
      }
      throw err;
    }

    // Surface error-path runs as exceptions so the action executor can
    // record the failure rather than silently completing the backlog item.
    if (loop.status === 'errored' && loop.error) {
      const err = new Error(loop.error);
      log(`!! agent loop errored: ${loop.error}`);
      if (opts.onError) {
        await opts.onError(err, prepInput);
      }
      throw err;
    }

    const result: AgenticRunResult = { status: loop.rawStatus, steps: loop.steps };
    const summary = summarize(result);
    log(`agent finished: status=${loop.status} steps=${loop.steps.length}`);
    log(summary);

    return {
      completed: true,
      summaryProse: summary,
    };
  };
}
