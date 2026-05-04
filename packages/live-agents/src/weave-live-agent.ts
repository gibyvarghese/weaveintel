/**
 * `weaveLiveAgent` — canonical user-facing constructor for a live-agent task
 * handler. Mirrors `weaveAgent({ model, tools, policy, ... })` from
 * `@weaveintel/agents` so a developer who knows one knows the other.
 *
 * Phase 4 of `docs/live-agents/LLM_FIRST_CLASS_CAPABILITY_PLAN.md`.
 *
 * Returns `{ handler, definition }` where:
 *   - `handler`    — the `TaskHandler` to register against the runtime.
 *   - `definition` — declarative metadata describing what capability slots
 *                    were supplied. Useful for introspection, hydration, and
 *                    upcoming `weaveLiveSupervisor` / `weaveLiveMesh` wiring
 *                    (Phase 6).
 *
 * The legacy `createAgenticTaskHandler(opts)` factory remains exported as a
 * deprecated alias for one minor cycle.
 */

import type { ExecutionContext, Model, ToolRegistry } from '@weaveintel/core';
import type { ContextPolicy } from './types.js';
import type { TaskHandler } from './action-executor.js';
import {
  createAgenticTaskHandler,
  type AgenticPrepareInput,
  type AgenticPreparation,
  type AgenticRunResult,
  type AgenticTaskHandlerOptions,
} from './agentic-task-handler.js';
import type { ModelResolver } from './model-resolver.js';
import type { ModelCapabilitySpec } from './llm/types.js';
import type { LiveAgentPolicy } from './policy.js';

/**
 * Minimal `EventBus` shape for live-agents observability adapters. Kept
 * structurally compatible with `@weaveintel/agents` `EventBus` so callers
 * can pass either implementation. Runtime bridging into
 * `LiveAgentsObservability` is Phase 6 — for now `bus` is captured on the
 * definition for introspection only.
 */
export interface LiveAgentBus {
  emit(event: string, payload: unknown): void | Promise<void>;
}

/**
 * Options accepted by `weaveLiveAgent`. Designed for parity with
 * `weaveAgent` — every field name that exists on both packages means the
 * same thing.
 */
export interface WeaveLiveAgentOptions {
  // -- Identity --------------------------------------------------------
  /** Display name used in logs and registered against the runtime. */
  name: string;
  /** Logical role hint used by `modelResolver` and as the default for
   *  `agentPersona` in tool-policy resolution. Defaults to `name`. */
  role?: string;

  // -- Model (mirrors weaveAgent) -------------------------------------
  /** Pinned model. Either `model` OR `modelResolver` (or both) is required. */
  model?: Model;
  /** Per-tick resolver — first-class capability slot (Phase 1). */
  modelResolver?: ModelResolver;
  /** Capability hint forwarded to `modelResolver.resolve(ctx)`. */
  modelCapability?: ModelCapabilitySpec;

  // -- Tools (mirrors weaveAgent) -------------------------------------
  /**
   * Default tool registry used when no per-tick `prepare()` is supplied,
   * or when `prepare()` returns a preparation without `tools`. Domain code
   * that needs to swap tools per tick should still use `prepare`.
   */
  tools?: ToolRegistry;

  // -- Capabilities (mirrors weaveAgent) ------------------------------
  /** Default system prompt used when `prepare()` is not supplied. */
  systemPrompt?: string;
  /** Maximum tool-call loops in one tick. Defaults to 60. */
  maxSteps?: number;
  /** Tool-policy bundle — first-class capability slot (Phase 3). */
  policy?: LiveAgentPolicy;
  /**
   * Memory / context policy — alias for `contextPolicy` on the contract.
   * Captured on the returned `definition` for downstream mesh wiring
   * (Phase 6). Not yet read by the handler itself.
   */
  memory?: ContextPolicy;
  /**
   * Observability bus adapter. Captured on the returned `definition` for
   * downstream bridging into `LiveAgentsObservability` (Phase 6). Not yet
   * read by the handler itself.
   */
  bus?: LiveAgentBus;

  // -- Live-agents extensions -----------------------------------------
  /**
   * Per-tick preparation. When omitted, a default `prepare()` is
   * synthesized that returns `{ systemPrompt, tools, userGoal }` derived
   * from the static fields above plus the inbound TASK body.
   */
  prepare?: (input: AgenticPrepareInput) => Promise<AgenticPreparation> | AgenticPreparation;
  /** Optional summarizer for the agent's final result. */
  summarize?: (result: AgenticRunResult) => string;
  /** Optional logger. Defaults to `console.log` with `[name]` prefix. */
  log?: (msg: string) => void;
  /** Optional error hook fired when the underlying ReAct loop throws. */
  onError?: (err: unknown, input: AgenticPrepareInput) => Promise<void> | void;
}

/**
 * Declarative description of a live-agent. Captures which capability slots
 * were supplied at construction so downstream code (mesh provisioner,
 * supervisor, admin UI) can introspect without re-running the handler.
 */
export interface LiveAgentDefinition {
  name: string;
  role: string;
  capabilities: {
    /** True when at least one of `model`/`modelResolver` was supplied. */
    model: boolean;
    /** True when `modelResolver` was supplied (per-tick routing). */
    modelResolver: boolean;
    /** True when a default `tools` registry was supplied. */
    tools: boolean;
    /** True when `policy` was supplied (any of the four primitives). */
    policy: boolean;
    /** True when `memory` (contextPolicy alias) was supplied. */
    memory: boolean;
    /** True when `bus` was supplied. */
    bus: boolean;
    /** True when a custom `prepare()` was supplied. */
    customPrepare: boolean;
  };
  /** Echoed back so `weaveLiveSupervisor` / mesh wiring (Phase 6) can
   *  read the original options without re-binding. Mutating this object
   *  has no effect on the handler. */
  options: WeaveLiveAgentOptions;
}

/**
 * Result returned by `weaveLiveAgent`. Pattern matches `weaveAgent`'s
 * `{ run, agent }` shape but live-agents returns a TaskHandler (the
 * runtime invokes it once per tick) and a definition (introspection).
 */
export interface WeaveLiveAgentResult {
  handler: TaskHandler;
  definition: LiveAgentDefinition;
}

/**
 * Build a default `prepare()` for callers that only want a static
 * system prompt + inbound body. Mirrors the simplest `weaveAgent` shape.
 */
function buildDefaultPrepare(
  systemPrompt: string,
  tools: ToolRegistry | undefined,
): (input: AgenticPrepareInput) => AgenticPreparation {
  return ({ inbound }) => ({
    systemPrompt,
    ...(tools ? { tools } : {}),
    userGoal: inbound?.body ?? inbound?.subject ?? '',
  });
}

/**
 * Canonical user-facing constructor for a live-agent task handler.
 *
 * @example Simple pinned agent
 * ```ts
 * const { handler, definition } = weaveLiveAgent({
 *   name: 'researcher',
 *   model: openaiModel('gpt-4o'),
 *   tools: myToolRegistry,
 *   systemPrompt: 'You are a research analyst.',
 *   policy: weaveLiveAgentPolicy({ auditEmitter }),
 * });
 * runtime.registerHandler('agentic.react', handler);
 * ```
 *
 * @example Per-tick routing with custom prepare
 * ```ts
 * const { handler } = weaveLiveAgent({
 *   name: 'kaggle-strategist',
 *   modelResolver: weaveDbModelResolver({ ... }),
 *   prepare: async ({ inbound }) => loadPlaybookForCompetition(inbound),
 *   policy: weaveDbLiveAgentPolicy({ ... }),
 * });
 * ```
 */
export function weaveLiveAgent(opts: WeaveLiveAgentOptions): WeaveLiveAgentResult {
  if (!opts.model && !opts.modelResolver) {
    throw new TypeError(
      `weaveLiveAgent('${opts.name}'): one of \`model\` (pinned) or ` +
        '`modelResolver` (per-tick) is required.',
    );
  }
  if (!opts.prepare && !opts.systemPrompt) {
    throw new TypeError(
      `weaveLiveAgent('${opts.name}'): either \`prepare\` (per-tick) or ` +
        '`systemPrompt` (static) is required so the ReAct loop has a system message.',
    );
  }

  const prepare =
    opts.prepare ?? buildDefaultPrepare(opts.systemPrompt as string, opts.tools);

  // Translate to the underlying handler's option shape. Conditional
  // spreads keep `exactOptionalPropertyTypes` happy.
  const handlerOpts: AgenticTaskHandlerOptions = {
    name: opts.name,
    prepare,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.modelResolver ? { modelResolver: opts.modelResolver } : {}),
    ...(opts.role ? { role: opts.role } : {}),
    ...(opts.modelCapability ? { modelCapability: opts.modelCapability } : {}),
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.summarize ? { summarize: opts.summarize } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.onError ? { onError: opts.onError } : {}),
  };

  const handler = createAgenticTaskHandler(handlerOpts);

  const definition: LiveAgentDefinition = {
    name: opts.name,
    role: opts.role ?? opts.name,
    capabilities: {
      model: !!(opts.model || opts.modelResolver),
      modelResolver: !!opts.modelResolver,
      tools: !!opts.tools,
      policy: !!opts.policy,
      memory: !!opts.memory,
      bus: !!opts.bus,
      customPrepare: !!opts.prepare,
    },
    options: opts,
  };

  return { handler, definition };
}

// Re-export for callers that destructure the type from this file.
export type { ExecutionContext };
