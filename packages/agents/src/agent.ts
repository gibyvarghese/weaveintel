/**
 * @weaveintel/agents — Tool-calling agent runtime
 *
 * Implements the ReAct-style tool-calling loop:
 *   1. Send messages to model
 *   2. If model returns tool calls → execute tools → append results → loop
 *   3. If model returns text → return as final response
 *
 * Supports budget enforcement, step tracking, policy checks, streaming,
 * and graceful cancellation.
 */

import type {
  Agent,
  AgentConfig,
  AgentInput,
  AgentResult,
  AgentStep,
  AgentStepEvent,
  AgentUsage,
  AgentMemory,
  AgentPolicy,
  Critic,
  Verifier,
  Model,
  Message,
  ToolCall,
  ToolRegistry,
  ExecutionContext,
  EventBus,
  SupervisorConfig,
  ResponseFormat,
} from '@weaveintel/core';
import {
  WeaveIntelError,
  isExpired,
  weaveChildContext,
  weaveEvent,
  EventTypes,
  weaveToolRegistry,
  weaveResolveTracer,
  weaveAudit,
} from '@weaveintel/core';
import { buildSupervisorRuntime, type WorkerDefinition } from './supervisor-runtime.js';
import type { WorkerRegistry } from './worker-registry.js';
import { applyContextManagement, type ContextManagementOptions } from './context-manager.js';
import {
  buildHandoffTools,
  HandoffSignal,
  type HandoffDefinition,
  type HandoffMetadata,
} from './handoff.js';
import type { InterruptHandler, InterruptEvent } from './interrupt.js';
import {
  generateRunId,
  type AgentCheckpoint,
  type CheckpointStore,
} from './checkpoint.js';
import type { EvalPipelineOptions, EvalPipelineReport } from './eval-pipeline.js';
import type {
  CostGovernorBundle,
  CostLedger,
  CostLedgerSink,
  CostLedgerEntry,
  PricingResolver,
} from '@weaveintel/cost-governor';
import { wrapModelWithCostLedger } from '@weaveintel/cost-governor';
import type { ContentPart, ImageContent } from '@weaveintel/core';

async function withObservedSpan<T>(
  ctx: ExecutionContext,
  name: string,
  attributes: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = weaveResolveTracer(ctx);
  if (!tracer) {
    return fn();
  }
  return tracer.withSpan(ctx, name, () => fn(), attributes);
}

// ─── Agent builder ───────────────────────────────────────────

export interface ToolCallingAgentOptions {
  /** Model to use for generation */
  model: Model;
  /** Tool registry */
  tools?: ToolRegistry;
  /** Event bus for observability */
  bus?: EventBus;
  /** System prompt / instructions */
  systemPrompt?: string;
  /** Maximum number of tool-call loops before stopping */
  maxSteps?: number;
  /** Agent name */
  name?: string;
  /** Agent memory */
  memory?: AgentMemory;
  /** Policy for approval / budget */
  policy?: AgentPolicy;
  /**
   * Worker agents to delegate to. When provided, this agent runs in
   * supervisor mode: built-in `think`, `plan`, and `delegate_to_worker`
   * tools are auto-registered and the system prompt is composed with the
   * supervisor workflow guidance.
   */
  workers?: WorkerDefinition[];
  /**
   * Additional tools the supervisor may call directly (e.g. CSE / MCP
   * tools). Only meaningful when `workers` is set.
   */
  additionalTools?: ToolRegistry;
  /**
   * Tool names treated as CSE code-execution endpoints by the supervisor's
   * delegate-to-code redirection. Only meaningful when `workers` is set.
   */
  cseCodeToolNames?: string[];
  /**
   * When true (default), the supervisor receives pure utility tools
   * (`datetime`, `math_eval`, `unit_convert`) in addition to think/plan/
   * delegate_to_worker. Set to false to opt out (e.g. for ultra-minimal
   * supervisors). Only meaningful when `workers` is set.
   */
  includeUtilityTools?: boolean;
  /** Default timezone passed to the supervisor's `datetime` utility tool. */
  defaultTimezone?: string;
  /**
   * Maximum number of delegations. Only meaningful when `workers` is set.
   * Defaults to `maxSteps` when omitted.
   */
  maxDelegations?: number;
  /**
   * W3 — Re-plan on failure. Only meaningful when `workers` is set.
   * When true, failed worker results include a REPLAN_REQUIRED signal so the
   * supervisor LLM knows to revise its plan rather than give up.
   */
  replanOnFailure?: boolean;
  /**
   * W3 — Parallel delegation. Only meaningful when `workers` is set.
   * When true, a `delegate_to_workers_parallel` batch tool is registered so
   * the supervisor can dispatch independent sub-tasks concurrently.
   */
  parallelDelegation?: boolean;
  /**
   * W1 — Reflection mode: self-correction loop at each terminal response.
   * When set, the agent critiques its own output before returning. If the
   * critique rejects, feedback is appended as a new user turn and the loop
   * continues. Consumes from the shared `maxSteps` budget.
   * Default: not set (reflection disabled).
   */
  reflect?: {
    /** Maximum number of revision cycles before accepting as-is. Default 1. */
    maxRevisions?: number;
    /** Criteria text describing what "good" means. Fed to the critic prompt. */
    criteria?: string;
    /** Critic implementation. Defaults to a self-critic using the same model. */
    critic?: Critic;
    /** For scored critics: accept when score >= minScore. Default 0.7. */
    minScore?: number;
  };
  /**
   * W2 — Evaluator-optimizer mode: verify→regenerate loop at each terminal
   * response. When set, the verifier runs after guardrails; if it returns
   * `passed: false`, the output is appended as "failed verification" and the
   * loop regenerates. Shares the `maxSteps` budget.
   * Default: not set (verify disabled).
   */
  verify?: {
    /** Verifier implementation. */
    verifier: Verifier;
    /** Maximum regeneration attempts. Default 1. */
    maxAttempts?: number;
  };
  /**
   * P1-2 — Approval gate: when true, every `run()` call checks that
   * `policy.approveToolCall` is wired. If no gate is provided the agent
   * immediately returns `status: 'needs_approval'` instead of running. Wire
   * an `AgentPolicy` with `approveToolCall` to handle the approval flow.
   */
  requireApproval?: boolean;
  /**
   * P2-1 — Parallel tool execution: when true (default), all tool calls
   * returned in a single model response are executed concurrently via
   * Promise.all. Set to false to restore the original sequential behaviour.
   */
  parallelToolCalls?: boolean;
  /**
   * P2-2 — Structured output: when set, the model is instructed to respond
   * with JSON conforming to this schema.  At each terminal response the agent
   * validates the JSON; on failure it retries by appending a nudge message.
   * The parsed object is stored in `AgentResult.metadata.structuredOutput`.
   */
  outputSchema?: ResponseFormat;
  /**
   * P2-2 — Maximum number of times the agent will retry a terminal response
   * that fails JSON validation.  Default: 1.
   */
  structuredOutputRetries?: number;
  /**
   * P2-3 — Context window management: when set, the agent trims or
   * summarises older conversation turns before each model call so the context
   * stays within the chosen token budget.
   */
  contextManagement?: ContextManagementOptions;
  /**
   * P2-4 — Tool retry with exponential back-off: when set, transient errors
   * from tool.invoke() are retried up to `maxAttempts` times before the
   * error result is surfaced to the model.
   */
  toolRetry?: {
    /** Total invocation attempts including the first try. Default: 3. */
    maxAttempts?: number;
    /** Base delay in ms for the first back-off interval. Default: 200. */
    backoffMs?: number;
    /** Upper cap on jittered back-off delay in ms. Default: 10 000. */
    maxBackoffMs?: number;
  };
  /**
   * P3-1 — HITL interrupt handler: when provided, the agent will call this
   * function before executing any tool call whose tool schema has
   * `requireApproval: true`, OR when `requireApproval` is set on the agent
   * config (apply to ALL tool calls).
   *
   * The handler suspends the agent loop until the returned promise resolves
   * with an `InterruptResolution` (approve / reject / modify).
   *
   * Use `createHumanTaskInterruptHandler(queue)` to back this with a
   * `@weaveintel/human-tasks` queue for DB-persistent approvals.
   */
  onInterrupt?: InterruptHandler;
  /**
   * P3-2 — Agent handoffs: a list of peer agents this agent may transfer
   * control to mid-task.  For each entry a `transfer_to_<name>` tool is
   * auto-registered.  When the LLM calls one, the current agent terminates
   * and the target agent runs with the provided context.
   * The final result carries `metadata.handoff` describing the transfer.
   */
  handoffs?: HandoffDefinition[];

  /**
   * P5-1 — Agent checkpoint / resume.
   *
   * When set, the agent saves an `AgentCheckpoint` snapshot after every
   * `intervalSteps` steps (default: every step) and again on any terminal
   * outcome (completed / failed / cancelled / budget_exceeded).
   *
   * The `runId` uniquely identifies this run; if omitted it is auto-generated
   * as `<agentName>:<epoch-ms>:<random>` and available in the checkpoint.
   *
   * To resume: load the checkpoint with `store.load(runId)`, then call
   * `resumeFromCheckpoint(checkpoint, agentOpts)` to build an agent whose
   * `run()` pre-seeds the checkpoint's conversation history.
   */
  checkpoint?: {
    /** Backing store for checkpoint snapshots. */
    store: CheckpointStore;
    /**
     * Save a snapshot every N tool-call steps. Default: every step.
     * Terminal checkpoints (completed/failed) are always saved regardless
     * of this setting.
     */
    intervalSteps?: number;
    /**
     * Caller-supplied run ID. If omitted, an ID is auto-generated and
     * available in each saved checkpoint's `runId` field.
     */
    runId?: string;
  };
  /**
   * P5-2 — Dynamic worker registry.
   *
   * Alternative to the static `workers` array. When provided, the supervisor's
   * `delegate_to_worker` tool resolves workers from the registry at call time
   * so you can add or remove workers without recreating the supervisor.
   *
   * Can be used alongside `workers` (which then only sets the initial system
   * prompt description). Or use it without `workers` for a fully dynamic setup.
   */
  workerRegistry?: WorkerRegistry;

  /**
   * P4-2 — Proactive memory context injection.
   *
   * When provided, `retrieve()` is called before each `model.generate()`
   * with the most recent user message as the query.  The returned string
   * (if non-null) is prepended to the system prompt for that specific
   * generate call so the model can ground its response in long-term context.
   *
   * The augmentation is ephemeral: it is NOT appended to the permanent
   * conversation history, so memory context does not accumulate across steps.
   *
   * Mirrors the `buildMemoryContext` + augmented-system-prompt pattern from
   * a host application's `chat-send-message.ts`, made portable for standalone agents.
   */
  memoryContext?: {
    /**
     * Called with the latest user message text before each model generation.
     * Return a non-empty string to inject it as extra system content, or
     * `null` / empty string to skip injection for this step.
     */
    retrieve(ctx: ExecutionContext, latestUserMessage: string): Promise<string | null>;
    /**
     * Approximate maximum character length to trim the retrieved context to.
     * Roughly maps to `maxTokens * 4` characters.  Defaults to no limit.
     */
    maxChars?: number;
  };

  // ── P6-1: Multi-tier evaluation pipeline ─────────────────────

  /**
   * P6-1 — Multi-tier evaluation pipeline.
   *
   * Chains: schema-check → rubric critic → verifier → ensemble arbiter as a
   * single configurable pipeline run AFTER the main response is produced.
   * Each stage is optional; `failFast: true` (default) short-circuits on first
   * rejection. When a stage rejects, feedback is fed back into the run loop as
   * a new user turn so the agent can regenerate within its remaining step budget.
   *
   * The full per-stage report is stored in `AgentResult.metadata.evalPipeline`.
   */
  evalPipeline?: EvalPipelineOptions;

  // ── P6-3: Cost-aware routing ──────────────────────────────────

  /**
   * P6-3 — Cost-aware agent routing.
   *
   * When provided, the agent's model is wrapped with a cost ledger interceptor
   * so every `generate()` call records token usage and estimated USD cost.
   * The `bundle` levers (historyCompactor, toolOutputTruncator) are applied
   * inside the run loop to control context size and output verbosity.
   *
   * `AgentResult.metadata.costBreakdown` is populated at termination when a
   * `ledger` with `breakdown()` support is provided.
   */
  costGovernor?: {
    /** Pre-built governor bundle (from `weaveCostGovernor(policy)`). */
    bundle: CostGovernorBundle;
    /** Full ledger with breakdown support (e.g. `createInMemoryCostLedger()`). */
    ledger?: CostLedger;
    /** Pricing resolver used to compute USD per token. */
    pricing?: PricingResolver;
    /**
     * Run ID used to scope ledger entries. If omitted, the checkpoint runId
     * or an auto-generated ID is used.
     */
    runId?: string;
  };

  // ── P6-4: Compliance-aware tool execution ─────────────────────

  /**
   * P6-4 — Compliance-aware tool execution.
   *
   * When provided, each tool call is preceded by a consent check against
   * `ctx.runtime?.compliance`. Tool calls are blocked when consent has not
   * been granted for the required purpose. All tool invocations are tagged
   * with their data classification in the audit trail.
   *
   * Requires `ctx.runtime.compliance` to be wired (e.g. via
   * `createRuntimeComplianceAdapter()` from `@weaveintel/compliance`).
   */
  complianceTools?: {
    /**
     * Subject ID (e.g. user ID) for consent and residency checks.
     * When omitted, compliance checks are skipped (fail-open).
     */
    subjectId?: string;
    /**
     * Required consent purpose for ALL tool calls.
     * Default: `'agent.tool.execute'`.
     */
    purpose?: string;
    /**
     * Per-tool data classification tags included in audit events.
     * Key: tool name, Value: data category (e.g. `'PII'`, `'PHI'`, `'FINANCIAL'`).
     */
    dataClassifications?: Record<string, string>;
    /**
     * When true (default), block tool calls when consent is denied.
     * When false, log the denial but allow execution (audit-only mode).
     */
    enforceConsent?: boolean;
  };

  // ── P6-5: Vision-loop browser agent ──────────────────────────

  /**
   * P6-5 — Vision-loop browser agent.
   *
   * When true, tool outputs that match the screenshot JSON pattern
   * `{ "format": "png", "base64": "<data>" }` (or `{ "type": "image", ... }`)
   * are automatically converted to `ImageContent` parts and injected into the
   * next model call as visual input. This lets vision-capable models (Claude,
   * GPT-4o) "see" browser screenshots rather than receiving raw base64 strings.
   *
   * Requires a vision-capable model (`Capabilities.Vision`).
   */
  visionLoop?: boolean;
}

// ─── Reflection / verify shared helper ───────────────────────

/**
 * Lazily build the default self-critic (loaded only when reflect is used).
 * Dynamic import keeps reflect.ts out of the critical path for non-reflect agents.
 */
async function buildDefaultCritic(model: Model, criteria?: string): Promise<Critic> {
  const { createSelfCritic } = await import('./reflect.js');
  return createSelfCritic({ model, criteria });
}

// ─── P2-2: Structured output validation ──────────────────────

function validateStructuredOutput(
  content: string,
  schema: ResponseFormat,
): { valid: boolean; parsed?: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { valid: false };
  }
  // For json_schema with a `required` array, verify each key is present.
  if (schema.type === 'json_schema' && schema.schema) {
    const s = schema.schema as { required?: string[] };
    if (Array.isArray(s.required)) {
      const obj = parsed as Record<string, unknown>;
      for (const key of s.required) {
        if (!(key in obj)) return { valid: false };
      }
    }
  }
  return { valid: true, parsed };
}

// ─── P2-4: Tool retry helpers ─────────────────────────────────

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('Rate limit') ||
    msg.includes('timeout') ||
    msg.includes('Timeout') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('network error') ||
    msg.includes('socket hang up') ||
    msg.includes('connection reset')
  );
}

/** Full-jitter exponential back-off: delay ∈ [0, min(cap, base * 2^attempt)] */
async function backoffDelay(
  attempt: number,
  backoffMs: number,
  maxBackoffMs: number,
): Promise<void> {
  const cap = Math.min(maxBackoffMs, backoffMs * Math.pow(2, attempt));
  const delay = Math.random() * cap;
  await new Promise<void>((r) => setTimeout(r, delay));
}

// ─── P4-2: Memory context injection helpers ───────────────────

/**
 * Find the last user-role message content string in a messages array.
 * Returns an empty string when no user message is found.
 */
function lastUserMessageText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') {
      return typeof m.content === 'string' ? m.content : '';
    }
  }
  return '';
}

// ─── P6-5: Vision-loop screenshot detection ──────────────────

/**
 * Try to extract an `ImageContent` part from a tool result string.
 * Detects two patterns:
 *   1. JSON: `{ "format": "png", "base64": "<data>" }` (browser_screenshot output)
 *   2. JSON: `{ "type": "image", "base64": "<data>", "mimeType": "image/png" }`
 *
 * Returns null when the string doesn't match either pattern (fast path for
 * non-screenshot tool results).
 */
function tryExtractScreenshot(result: string): ImageContent | null {
  if (!result.startsWith('{')) return null;
  try {
    const obj = JSON.parse(result) as Record<string, unknown>;
    // Pattern 1: { format: 'png', base64: '...' }
    if (typeof obj['base64'] === 'string' && (obj['format'] === 'png' || obj['format'] === 'jpeg' || obj['format'] === 'webp')) {
      return {
        type: 'image',
        base64: obj['base64'],
        mimeType: `image/${String(obj['format'])}`,
      } as ImageContent;
    }
    // Pattern 2: { type: 'image', base64: '...', mimeType: '...' }
    if (obj['type'] === 'image' && typeof obj['base64'] === 'string') {
      return {
        type: 'image',
        base64: obj['base64'],
        ...(typeof obj['mimeType'] === 'string' ? { mimeType: obj['mimeType'] } : { mimeType: 'image/png' }),
      } as ImageContent;
    }
    // Pattern 3: { url: '...', type: 'image' }
    if (obj['type'] === 'image' && typeof obj['url'] === 'string') {
      return { type: 'image', url: obj['url'] } as ImageContent;
    }
  } catch {
    /* not JSON — return null */
  }
  return null;
}

/**
 * Build a messages array for a single `generate()` call that has the
 * retrieved memory context prepended to the system message (or inserted as a
 * new system message when none exists).  The original `messages` array is
 * never mutated.
 */
function buildMessagesWithMemoryContext(
  messages: readonly Message[],
  memoryCtx: string,
  maxChars?: number,
): Message[] {
  let trimmed = memoryCtx;
  if (maxChars && trimmed.length > maxChars) {
    trimmed = trimmed.slice(0, maxChars) + '\n[memory context trimmed]';
  }

  const withMem = trimmed
    ? `${trimmed}\n\n`
    : '';

  if (withMem === '') return [...messages];

  // If there's an existing system message, augment it.
  if (messages.length > 0 && messages[0]!.role === 'system') {
    const existing = typeof messages[0]!.content === 'string'
      ? messages[0]!.content
      : '';
    return [
      { ...messages[0]!, content: `${withMem}${existing}` },
      ...messages.slice(1),
    ];
  }

  // Otherwise prepend a new system message.
  return [
    { role: 'system', content: trimmed },
    ...messages,
  ];
}

export function weaveAgent(opts: ToolCallingAgentOptions): Agent {
  // P5-2: supervisor mode is activated by workers[], workerRegistry, or both.
  const isSupervisor =
    (Array.isArray(opts.workers) && opts.workers.length > 0) ||
    (opts.workerRegistry !== undefined && opts.workerRegistry.size > 0);
  const supervisorRuntime = isSupervisor
    ? buildSupervisorRuntime({
        supervisorName: opts.name ?? 'supervisor',
        baseInstructions: opts.systemPrompt,
        workers: opts.workers ?? [],
        workerRegistry: opts.workerRegistry,
        buildWorkerAgent: (w, bus) => weaveAgent({
          name: w.name,
          model: w.model,
          systemPrompt: w.systemPrompt,
          tools: w.tools,
          bus,
        }),
        maxDelegations: opts.maxDelegations ?? opts.maxSteps ?? 10,
        bus: opts.bus,
        policy: opts.policy,
        additionalTools: opts.additionalTools,
        cseCodeToolNames: opts.cseCodeToolNames,
        includeUtilityTools: opts.includeUtilityTools,
        defaultTimezone: opts.defaultTimezone,
        replanOnFailure: opts.replanOnFailure,
        parallelDelegation: opts.parallelDelegation,
      })
    : undefined;

  const baseConfig: AgentConfig = {
    name: opts.name ?? (isSupervisor ? 'supervisor' : 'tool-agent'),
    instructions: supervisorRuntime?.systemPrompt ?? opts.systemPrompt,
    maxSteps: opts.maxSteps ?? (isSupervisor ? 30 : 20),
    ...(opts.requireApproval !== undefined && { requireApproval: opts.requireApproval }),
  };
  const config: AgentConfig | SupervisorConfig = supervisorRuntime
    ? {
        ...baseConfig,
        workers: supervisorRuntime.workersConfig,
        maxDelegations: opts.maxDelegations ?? opts.maxSteps ?? 10,
      } as SupervisorConfig
    : baseConfig;
  const { model: baseModel, memory, policy } = opts;
  const eventBus = opts.bus;
  const maxSteps = config.maxSteps ?? 20;

  // P6-3: Optionally wrap model with cost ledger interceptor.
  // The sink adapts CostLedger.record → CostLedgerSink.append interface.
  const cgOpts = opts.costGovernor;
  const cgRunId = cgOpts?.runId ?? generateRunId(config.name);
  let model = baseModel;
  if (cgOpts?.ledger) {
    const ledger = cgOpts.ledger;
    const sink: CostLedgerSink = { append: (e: CostLedgerEntry) => ledger.record(e) };
    const pricing: PricingResolver = cgOpts.pricing ?? { resolve: () => null };
    model = wrapModelWithCostLedger(baseModel, {
      sink,
      pricing,
      newId: () => Math.random().toString(36).slice(2),
      resolveContext: () => ({ runId: cgRunId, agentId: config.name }),
      source: 'agentic.react',
    });
  }

  // P3-2: Build and merge handoff tools into the tool registry.
  const baseToolReg = supervisorRuntime?.tools ?? opts.tools ?? weaveToolRegistry();
  let toolReg = baseToolReg;
  if (opts.handoffs && opts.handoffs.length > 0) {
    const handoffTools = buildHandoffTools(opts.handoffs, null);
    if (handoffTools.length > 0) {
      const merged = weaveToolRegistry();
      for (const t of baseToolReg.list()) merged.register(t);
      for (const t of handoffTools) merged.register(t);
      toolReg = merged;
    }
  }

  return {
    config,

    async run(ctx: ExecutionContext, input: AgentInput): Promise<AgentResult> {
      // P1-1: reset per-run supervisor state so delegation counts and thinking
      // logs from a previous invocation don't bleed into this one.
      supervisorRuntime?.reset();

      const startTime = Date.now();
      const steps: AgentStep[] = [];
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let toolCallCount = 0;
      // W1/W2 — track revision/verify budgets across the loop
      let revisionCount = 0;
      let verifyAttemptCount = 0;
      // Lazily resolved default critic (only when reflect is used without explicit critic)
      let resolvedCritic: Critic | undefined;
      // P2-2 — structured output state
      let structuredOutputRetryCount = 0;
      let structuredOutputParsed: unknown;
      // P2-4 — tool retry options (resolved once, used in executeToolCall)
      const toolRetryOpts = opts.toolRetry;
      // P2-1 — parallel tool execution (default true)
      const parallel = opts.parallelToolCalls !== false;
      // P3-1 — HITL interrupt handler
      const interruptOpts = opts.onInterrupt
        ? { handler: opts.onInterrupt, requireAll: config.requireApproval ?? false }
        : undefined;
      // P3-2 — handoff feedback messages to inject after a modification
      const pendingHandoffFeedback: string[] = [];
      // P5-1 — checkpoint state
      const checkpointOpts = opts.checkpoint;
      const activeRunId = checkpointOpts?.runId ?? generateRunId(config.name);
      const checkpointInterval = checkpointOpts?.intervalSteps ?? 1;

      // Helper: persist checkpoint; errors are swallowed (never crash the agent run).
      const saveCheckpoint = async (
        currentMessages: Message[],
        currentSteps: AgentStep[],
        currentStepIdx: number,
        terminalStatus?: AgentResult['status'],
      ): Promise<void> => {
        if (!checkpointOpts) return;
        const cp: AgentCheckpoint = {
          runId: activeRunId,
          agentName: config.name,
          stepIndex: currentStepIdx,
          messages: currentMessages.map((m) => ({ ...m })),
          steps: currentSteps.map((s) => ({ ...s })),
          tokenCounts: { prompt: totalPromptTokens, completion: totalCompletionTokens },
          revisionCount,
          verifyAttemptCount,
          structuredOutputRetryCount,
          toolCallCount,
          createdAt: new Date().toISOString(),
          ...(terminalStatus && {
            completedAt: new Date().toISOString(),
            status: terminalStatus,
          }),
        };
        await checkpointOpts.store.save(activeRunId, cp).catch(() => {});
      };

      // P1-2 / P3-1: if requireApproval is set but neither a policy gate nor an
      // onInterrupt handler is wired, surface needs_approval immediately.
      if (config.requireApproval && !opts.policy?.approveToolCall && !opts.onInterrupt) {
        void weaveAudit(ctx, {
          action: 'agent.approval.required',
          outcome: 'denied',
          resource: config.name,
          details: { reason: 'requireApproval is set but no approval gate (policy.approveToolCall or onInterrupt) is wired' },
        });
        return buildResult([], 0, 0, 0, Date.now(), 'needs_approval');
      }

      eventBus?.emit(weaveEvent(EventTypes.AgentRunStart, { agent: config.name, goal: input.goal }, ctx));
      void weaveAudit(ctx, { action: 'agent.run.start', outcome: 'success', resource: config.name, details: { goal: input.goal } });

      // Build conversation from history + input
      const messages: Message[] = [];
      if (config.instructions) {
        messages.push({ role: 'system', content: config.instructions });
      }

      // Load memory if available
      if (memory) {
        const history = await memory.getMessages(ctx);
        messages.push(...history);
      }
      messages.push(...input.messages);

      // Build tool definitions for the model
      const toolDefs = toolReg.toDefinitions();

      try {
        for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
          // Context checks
          if (isExpired(ctx)) {
            await saveCheckpoint(messages, steps, stepIdx, 'cancelled');
            return buildResult(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, 'cancelled');
          }

          // Budget check
          if (config.maxTokenBudget && (totalPromptTokens + totalCompletionTokens) >= config.maxTokenBudget) {
            await saveCheckpoint(messages, steps, stepIdx, 'budget_exceeded');
            return buildResult(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, 'budget_exceeded');
          }

          // Policy check
          if (policy) {
            const usage = buildUsage(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime);
            const decision = await policy.shouldContinue(ctx, steps, usage);
            if (!decision.continue) {
              await saveCheckpoint(messages, steps, stepIdx, 'cancelled');
              return buildResult(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, 'cancelled');
            }
          }

          const stepStart = Date.now();
          eventBus?.emit(weaveEvent(EventTypes.AgentStepStart, { agent: config.name, stepIndex: stepIdx }, ctx));

          // P3-1: Inject any HITL modification feedback before model call.
          while (pendingHandoffFeedback.length > 0) {
            messages.push({ role: 'user', content: pendingHandoffFeedback.shift()! });
          }

          // P2-3: Apply context management before the model call.
          if (opts.contextManagement) {
            const trimmed = await applyContextManagement(messages, opts.contextManagement, memory, ctx);
            if (trimmed !== messages) messages.splice(0, messages.length, ...trimmed);
          }

          // P4-2: Proactive memory context injection (ephemeral — not stored in history).
          let generateMessages: Message[] = messages;
          if (opts.memoryContext) {
            const userText = lastUserMessageText(messages);
            if (userText) {
              const retrieved = await opts.memoryContext.retrieve(ctx, userText).catch(() => null);
              if (retrieved) {
                generateMessages = buildMessagesWithMemoryContext(messages, retrieved, opts.memoryContext.maxChars);
              }
            }
          }

          // P6-3: History compaction — trim old turns before model call.
          if (cgOpts?.bundle) {
            const compacted = await cgOpts.bundle.historyCompactor(
              generateMessages as Array<{ role: string; content: string }>,
              { runId: cgRunId, agentId: config.name },
            );
            if (compacted !== generateMessages) {
              generateMessages = compacted as Message[];
            }
          }

          // Call model (P2-2: pass responseFormat when outputSchema is configured)
          const response = await withObservedSpan(
            ctx,
            'agents.model.generate',
            { agent: config.name, stepIndex: stepIdx, mode: 'run' },
            () => model.generate(ctx, {
              messages: generateMessages,
              tools: toolDefs.length > 0 ? toolDefs : undefined,
              toolChoice: toolDefs.length > 0 ? 'auto' : undefined,
              ...(opts.outputSchema && { responseFormat: opts.outputSchema }),
            }),
          );

          totalPromptTokens += response.usage.promptTokens;
          totalCompletionTokens += response.usage.completionTokens;

          // Handle tool calls
          if (response.toolCalls && response.toolCalls.length > 0) {
            // Append assistant message with tool calls
            messages.push({
              role: 'assistant',
              content: response.content || '',
              toolCalls: response.toolCalls,
            });

            // P2-1: Execute tools — parallel (default) or sequential.
            // P3-1/3-2: Each call also handles HITL interrupt checks and
            // propagates HandoffSignal for lateral transfer detection below.
            if (parallel) {
              const toolResults = await Promise.all(
                response.toolCalls.map((tc) =>
                  executeToolCall(ctx, tc, toolReg, policy, eventBus, config.name, stepIdx, stepStart, toolRetryOpts, interruptOpts, pendingHandoffFeedback, opts.complianceTools),
                ),
              );
              for (const toolStep of toolResults) {
                steps.push(toolStep);
                toolCallCount++;
              }
              // Batch-append ALL tool results in original call order.
              for (let i = 0; i < response.toolCalls.length; i++) {
                messages.push({
                  role: 'tool',
                  content: toolResults[i]!.toolCall?.result ?? '',
                  toolCallId: response.toolCalls[i]!.id,
                });
              }
            } else {
              for (const tc of response.toolCalls) {
                const toolStep = await executeToolCall(
                  ctx, tc, toolReg, policy, eventBus, config.name, stepIdx, stepStart, toolRetryOpts, interruptOpts, pendingHandoffFeedback, opts.complianceTools,
                );
                steps.push(toolStep);
                toolCallCount++;
                messages.push({
                  role: 'tool',
                  content: toolStep.toolCall?.result ?? '',
                  toolCallId: tc.id,
                });
              }
            }

            // P6-5: Vision loop — detect screenshot tool outputs and inject ImageContent.
            if (opts.visionLoop) {
              const visionMessages: Message[] = [];
              for (let mi = messages.length - response.toolCalls.length; mi < messages.length; mi++) {
                const toolMsg = messages[mi];
                if (toolMsg && toolMsg.role === 'tool') {
                  const imgContent = tryExtractScreenshot(typeof toolMsg.content === 'string' ? toolMsg.content : '');
                  if (imgContent) {
                    visionMessages.push({ role: 'user', content: [imgContent] as ContentPart[] });
                  }
                }
              }
              for (const vm of visionMessages) messages.push(vm);
            }

            eventBus?.emit(weaveEvent(EventTypes.AgentStepEnd, {
              agent: config.name,
              stepIndex: stepIdx,
              type: 'tool_call',
            }, ctx));

            // P5-1: Periodic checkpoint after tool-call steps.
            if (checkpointOpts && stepIdx % checkpointInterval === 0) {
              await saveCheckpoint(messages, steps, stepIdx + 1);
            }
            continue;
          }

          // No tool calls — this is a terminal response.
          // Phase 5: consult runtime guardrails.checkOutput before surfacing
          // the response. A deny is fail-closed + audited; a redactedText
          // replacement is used as-is. Missing slot = allow-all (graceful).
          let finalContent = response.content;
          const outputGuardrails = ctx.runtime?.guardrails;
          if (outputGuardrails?.checkOutput) {
            let outputDecision: { allow: boolean; redactedText?: string; reason?: string } = { allow: true };
            try {
              outputDecision = await outputGuardrails.checkOutput(ctx, response.content);
            } catch (err) {
              outputDecision = { allow: false, reason: `guardrails error: ${err instanceof Error ? err.message : String(err)}` };
            }
            if (!outputDecision.allow) {
              const deniedContent = `Response blocked by guardrails: ${outputDecision.reason ?? 'no reason'}`;
              void weaveAudit(ctx, { action: 'agent.output.denied', outcome: 'denied', resource: config.name, details: { reason: outputDecision.reason ?? 'guardrails' } });
              const deniedStep: AgentStep = {
                index: steps.length,
                type: 'response',
                content: deniedContent,
                durationMs: Date.now() - stepStart,
                tokenUsage: { prompt: response.usage.promptTokens, completion: response.usage.completionTokens },
              };
              steps.push(deniedStep);
              // M-21: return 'guardrail_denied' so callers can distinguish a
              // policy-blocked response from a legitimate completion.
              return buildResult(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, 'guardrail_denied');
            }
            if (outputDecision.redactedText !== undefined) {
              finalContent = outputDecision.redactedText;
            }
          }

          // ── P2-2: Validate structured output ─────────────────────────────
          if (opts.outputSchema && !isExpired(ctx)) {
            const soResult = validateStructuredOutput(finalContent, opts.outputSchema);
            if (soResult.valid) {
              structuredOutputParsed = soResult.parsed;
            } else if (structuredOutputRetryCount < (opts.structuredOutputRetries ?? 1)) {
              structuredOutputRetryCount++;
              void weaveAudit(ctx, {
                action: 'agent.structured_output.retry',
                outcome: 'failure',
                resource: config.name,
                details: { attempt: structuredOutputRetryCount },
              });
              messages.push({ role: 'assistant', content: finalContent });
              messages.push({
                role: 'user',
                content: `Your response must be valid JSON${opts.outputSchema.name ? ` conforming to schema "${opts.outputSchema.name}"` : ''}. Please respond with valid JSON only and no surrounding text.`,
              });
              continue;
            }
          }

          // ── W2: Verify →regenerate ────────────────────────────────────────
          if (opts.verify && !isExpired(ctx)) {
            const maxAttempts = opts.verify.maxAttempts ?? 1;
            if (verifyAttemptCount < maxAttempts) {
              let verifyResult: { passed: boolean; reason?: string; score?: number };
              try {
                verifyResult = await opts.verify.verifier.verify(ctx, finalContent, { userInput: lastUserMessage(messages) });
              } catch (err) {
                verifyResult = { passed: false, reason: `verifier error: ${err instanceof Error ? err.message : String(err)}` };
              }
              if (!verifyResult.passed) {
                verifyAttemptCount++;
                void weaveAudit(ctx, {
                  action: 'agent.verify.failed',
                  outcome: 'failure',
                  resource: config.name,
                  details: { attempt: verifyAttemptCount, reason: verifyResult.reason, score: verifyResult.score },
                });
                const verifyFeedbackStep: AgentStep = {
                  index: steps.length,
                  type: 'thinking',
                  content: `[verify:failed attempt=${verifyAttemptCount}] ${verifyResult.reason ?? 'did not pass'}`,
                  durationMs: Date.now() - stepStart,
                  tokenUsage: { prompt: response.usage.promptTokens, completion: response.usage.completionTokens },
                };
                steps.push(verifyFeedbackStep);
                // Append failed output + regeneration request as new user turn
                messages.push({ role: 'assistant', content: finalContent });
                messages.push({
                  role: 'user',
                  content: `Your previous response did not pass verification (${verifyResult.reason ?? 'quality check failed'}). Please regenerate a better response.`,
                });
                continue;
              }
            }
          }

          // ── W1: Reflect →revise ───────────────────────────────────────────
          if (opts.reflect && !isExpired(ctx)) {
            const maxRevisions = opts.reflect.maxRevisions ?? 1;
            if (revisionCount < maxRevisions) {
              if (!resolvedCritic) {
                resolvedCritic = opts.reflect.critic ?? await buildDefaultCritic(model, opts.reflect.criteria);
              }
              let critiqueResult: { accepted: boolean; feedback?: string; score?: number };
              try {
                critiqueResult = await resolvedCritic.critique(ctx, lastUserMessage(messages), finalContent);
              } catch (err) {
                critiqueResult = { accepted: false, feedback: `critic error: ${err instanceof Error ? err.message : String(err)}` };
              }
              if (!critiqueResult.accepted) {
                revisionCount++;
                void weaveAudit(ctx, {
                  action: 'agent.reflect.revise',
                  outcome: 'success',
                  resource: config.name,
                  details: { revision: revisionCount, score: critiqueResult.score, feedback: critiqueResult.feedback },
                });
                const reflectStep: AgentStep = {
                  index: steps.length,
                  type: 'thinking',
                  content: `[reflect:revision=${revisionCount}] ${critiqueResult.feedback ?? 'critique requested revision'}`,
                  durationMs: Date.now() - stepStart,
                  tokenUsage: { prompt: response.usage.promptTokens, completion: response.usage.completionTokens },
                };
                steps.push(reflectStep);
                // Append draft + critique feedback as new user turn
                messages.push({ role: 'assistant', content: finalContent });
                messages.push({
                  role: 'user',
                  content: `Please revise your response based on this feedback: ${critiqueResult.feedback ?? 'Improve the quality of your answer.'}`,
                });
                continue;
              }
              void weaveAudit(ctx, {
                action: 'agent.reflect.accepted',
                outcome: 'success',
                resource: config.name,
                details: { revision: revisionCount, score: critiqueResult.score },
              });
            }
          }

          const responseStep: AgentStep = {
            index: steps.length,
            type: 'response',
            content: finalContent,
            durationMs: Date.now() - stepStart,
            tokenUsage: { prompt: response.usage.promptTokens, completion: response.usage.completionTokens },
          };
          steps.push(responseStep);

          eventBus?.emit(weaveEvent(EventTypes.AgentStepEnd, {
            agent: config.name,
            stepIndex: stepIdx,
            type: 'response',
          }, ctx));

          // Save to memory
          if (memory) {
            for (const msg of input.messages) {
              await memory.addMessage(ctx, msg);
            }
            await memory.addMessage(ctx, { role: 'assistant', content: finalContent });
          }

          eventBus?.emit(weaveEvent(EventTypes.AgentRunEnd, {
            agent: config.name,
            status: 'completed',
            steps: steps.length,
          }, ctx));
          void weaveAudit(ctx, { action: 'agent.run.end', outcome: 'success', resource: config.name, details: { steps: steps.length, status: 'completed' } });

          // P5-1: Final checkpoint on successful completion.
          await saveCheckpoint(messages, steps, steps.length, 'completed');

          // P6-1: Multi-tier evaluation pipeline (run after the main loop).
          let evalPipelineReport: EvalPipelineReport | undefined;
          if (opts.evalPipeline && finalContent) {
            const { runEvalPipeline } = await import('./eval-pipeline.js');
            const pipelineOut = await runEvalPipeline(opts.evalPipeline, {
              ctx,
              content: finalContent,
              agentModel: model,
              agentName: config.name,
              conversationHistory: messages as Array<{ role: string; content: string }>,
            });
            evalPipelineReport = pipelineOut.report;
            // Use revised content if pipeline produced one (e.g. ensemble winner)
            if (pipelineOut.content !== finalContent) {
              finalContent = pipelineOut.content;
            }
          }

          // P6-3: Collect cost breakdown if ledger supports it.
          let costBreakdown: Awaited<ReturnType<CostLedger['breakdown']>> | undefined;
          if (cgOpts?.ledger) {
            costBreakdown = await cgOpts.ledger.breakdown(cgRunId).catch(() => undefined);
          }

          const completedMeta: Record<string, unknown> = {
            ...(structuredOutputParsed !== undefined ? { structuredOutput: structuredOutputParsed } : {}),
            ...(evalPipelineReport !== undefined ? { evalPipeline: evalPipelineReport } : {}),
            ...(costBreakdown !== undefined ? { costBreakdown } : {}),
          };

          return buildResult(
            steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, 'completed',
            Object.keys(completedMeta).length > 0 ? completedMeta : undefined,
          );
        }

        // Max steps exceeded — P5-1: save terminal failure checkpoint.
        await saveCheckpoint(messages, steps, steps.length, 'failed');
        return buildResult(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, 'failed');
      } catch (err) {
        // P3-2: HandoffSignal from a transfer_to_<name> tool — execute the
        // target agent and return its result as our own result.
        if (err instanceof HandoffSignal) {
          void weaveAudit(ctx, {
            action: 'agent.handoff',
            outcome: 'success',
            resource: config.name,
            details: { from: config.name, to: err.targetName },
          });
          eventBus?.emit(weaveEvent(EventTypes.AgentDelegation, {
            from: config.name,
            to: err.targetName,
            type: 'handoff',
          }, ctx));
          const handoffResult = await err.targetAgent.run(ctx, err.transferInput);
          const handoffMeta: HandoffMetadata = {
            from: config.name,
            to: err.targetName,
            transferInput: err.transferInput.goal,
          };
          return {
            ...handoffResult,
            metadata: {
              ...handoffResult.metadata,
              handoff: handoffMeta,
            },
          };
        }
        eventBus?.emit(weaveEvent(EventTypes.AgentRunEnd, {
          agent: config.name,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        }, ctx));
        void weaveAudit(ctx, { action: 'agent.run.end', outcome: 'failure', resource: config.name, details: { error: err instanceof Error ? err.message : String(err) } });
        throw err;
      }
    },

    async *runStream(ctx: ExecutionContext, input: AgentInput): AsyncIterable<AgentStepEvent> {
      // P1-1: same reset as run() — supervisor state must not carry over.
      supervisorRuntime?.reset();

      const startTime = Date.now();
      const steps: AgentStep[] = [];
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let toolCallCount = 0;
      // W1/W2 — reflect/verify budgets for runStream
      let streamRevisionCount = 0;
      let streamVerifyAttemptCount = 0;
      let streamResolvedCritic: Critic | undefined;
      // M-21: track guardrail denial for stream path so the final 'done' event
      // carries 'guardrail_denied' instead of 'completed'.
      let streamGuardrailDenied = false;
      // P2-2 — structured output for the stream path
      let streamStructuredOutputRetryCount = 0;
      let streamStructuredOutputParsed: unknown;
      // P2-1 — parallel tool execution (default true)
      const streamParallel = opts.parallelToolCalls !== false;
      // P2-4 — tool retry options
      const streamToolRetryOpts = opts.toolRetry;
      // P3-1 — HITL interrupt handler
      const streamInterruptOpts = opts.onInterrupt
        ? { handler: opts.onInterrupt, requireAll: config.requireApproval ?? false }
        : undefined;
      // P3-2 — handoff feedback messages to inject after a modification
      const streamPendingHandoffFeedback: string[] = [];

      const messages: Message[] = [];
      if (config.instructions) {
        messages.push({ role: 'system', content: config.instructions });
      }
      if (memory) {
        const history = await memory.getMessages(ctx);
        messages.push(...history);
      }
      messages.push(...input.messages);

      const toolDefs = toolReg.toDefinitions();

      try {
      for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
        if (isExpired(ctx)) break;

        if (config.maxTokenBudget && (totalPromptTokens + totalCompletionTokens) >= config.maxTokenBudget) break;

        const stepStart = Date.now();
        yield { type: 'step_start', step: { index: stepIdx, type: 'thinking', durationMs: 0 } };

        // P3-1: Inject any HITL modification feedback before model call.
        while (streamPendingHandoffFeedback.length > 0) {
          messages.push({ role: 'user', content: streamPendingHandoffFeedback.shift()! });
        }

        // P2-3: Apply context management before each model call.
        if (opts.contextManagement) {
          const trimmed = await applyContextManagement(messages, opts.contextManagement, memory, ctx);
          if (trimmed !== messages) messages.splice(0, messages.length, ...trimmed);
        }

        // P4-2: Proactive memory context injection (ephemeral — not stored in history).
        let streamGenerateMessages: Message[] = messages;
        if (opts.memoryContext) {
          const userText = lastUserMessageText(messages);
          if (userText) {
            const retrieved = await opts.memoryContext.retrieve(ctx, userText).catch(() => null);
            if (retrieved) {
              streamGenerateMessages = buildMessagesWithMemoryContext(messages, retrieved, opts.memoryContext.maxChars);
            }
          }
        }

        // Check if model supports streaming
        if (model.stream) {
          let accText = '';
          let accToolCalls: ToolCall[] = [];
          let finalUsage = { prompt: 0, completion: 0 };

          for await (const chunk of await withObservedSpan(
            ctx,
            'agents.model.stream',
            { agent: config.name, stepIndex: stepIdx, mode: 'stream' },
            () => Promise.resolve(model.stream!(ctx, {
              messages: streamGenerateMessages,
              tools: toolDefs.length > 0 ? toolDefs : undefined,
              toolChoice: toolDefs.length > 0 ? 'auto' : undefined,
              ...(opts.outputSchema && { responseFormat: opts.outputSchema }),
            })),
          )) {
            if (chunk.type === 'text' && chunk.text) {
              accText += chunk.text;
              yield { type: 'text_chunk', text: chunk.text };
            }
            if (chunk.type === 'tool_call' && chunk.toolCall) {
              const tc = chunk.toolCall as ToolCall;
              if (tc.id && tc.name) {
                accToolCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments || '' });
              } else if (tc.arguments && accToolCalls.length > 0) {
                const last = accToolCalls[accToolCalls.length - 1]!;
                (last as { id: string; name: string; arguments: string }).arguments += tc.arguments;
              }
            }
            if (chunk.type === 'usage' && chunk.usage) {
              finalUsage = { prompt: chunk.usage.promptTokens, completion: chunk.usage.completionTokens };
            }
          }

          totalPromptTokens += finalUsage.prompt;
          totalCompletionTokens += finalUsage.completion;

          if (accToolCalls.length > 0) {
            messages.push({ role: 'assistant', content: accText || '', toolCalls: accToolCalls });

            // P2-1: Parallel tool execution in streaming path.
            if (streamParallel) {
              for (const tc of accToolCalls) {
                yield { type: 'tool_start', step: { index: steps.length, type: 'tool_call', content: tc.name, durationMs: 0 } };
              }
              const toolResults = await Promise.all(
                accToolCalls.map((tc) =>
                  executeToolCall(ctx, tc, toolReg, policy, eventBus, config.name, stepIdx, stepStart, streamToolRetryOpts, streamInterruptOpts, streamPendingHandoffFeedback, opts.complianceTools),
                ),
              );
              for (let i = 0; i < accToolCalls.length; i++) {
                steps.push(toolResults[i]!);
                toolCallCount++;
                messages.push({ role: 'tool', content: toolResults[i]!.toolCall?.result ?? '', toolCallId: accToolCalls[i]!.id });
                yield { type: 'tool_end', step: toolResults[i]! };
              }
            } else {
              for (const tc of accToolCalls) {
                yield { type: 'tool_start', step: { index: steps.length, type: 'tool_call', content: tc.name, durationMs: 0 } };
                const toolStep = await executeToolCall(ctx, tc, toolReg, policy, eventBus, config.name, stepIdx, stepStart, streamToolRetryOpts, streamInterruptOpts, streamPendingHandoffFeedback, opts.complianceTools);
                steps.push(toolStep);
                toolCallCount++;
                messages.push({ role: 'tool', content: toolStep.toolCall?.result ?? '', toolCallId: tc.id });
                yield { type: 'tool_end', step: toolStep };
              }
            }
            continue;
          }

          // P2-2: Validate structured output before handing off to post-processor.
          if (opts.outputSchema && !isExpired(ctx)) {
            const soResult = validateStructuredOutput(accText, opts.outputSchema);
            if (soResult.valid) {
              streamStructuredOutputParsed = soResult.parsed;
            } else if (streamStructuredOutputRetryCount < (opts.structuredOutputRetries ?? 1)) {
              streamStructuredOutputRetryCount++;
              messages.push({ role: 'assistant', content: accText });
              messages.push({
                role: 'user',
                content: `Your response must be valid JSON${opts.outputSchema.name ? ` conforming to schema "${opts.outputSchema.name}"` : ''}. Please respond with valid JSON only and no surrounding text.`,
              });
              continue;
            }
          }

          // Terminal response via streaming — H-18: delegate to shared post-processor.
          const streamTerminal = await processTerminalResponse({
            ctx, model, rawContent: accText, agentName: config.name,
            messages, steps, stepStart, tokenUsage: finalUsage,
            verifyOpts: opts.verify, reflectOpts: opts.reflect,
            verifyAttemptCount: streamVerifyAttemptCount,
            revisionCount: streamRevisionCount,
            resolvedCritic: streamResolvedCritic,
            guardrailDenied: streamGuardrailDenied,
          });
          streamVerifyAttemptCount = streamTerminal.verifyAttemptCount;
          streamRevisionCount = streamTerminal.revisionCount;
          streamResolvedCritic = streamTerminal.resolvedCritic;
          streamGuardrailDenied = streamTerminal.guardrailDenied;

          if (streamTerminal.result.action === 'continue') {
            for (const ev of streamTerminal.result.events) yield ev;
            messages.push(...streamTerminal.result.appendMessages);
            continue;
          }

          const { finalContent: streamFinalContent } = streamTerminal.result;
          const responseStep: AgentStep = {
            index: steps.length,
            type: 'response',
            content: streamFinalContent,
            durationMs: Date.now() - stepStart,
            tokenUsage: finalUsage,
          };
          steps.push(responseStep);
          yield { type: 'step_end', step: responseStep };
          yield {
            type: 'done',
            result: buildResult(
              steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime,
              streamGuardrailDenied ? 'guardrail_denied' : 'completed',
              streamStructuredOutputParsed !== undefined ? { structuredOutput: streamStructuredOutputParsed } : undefined,
            ),
          };
          return;
        }

        // Non-streaming fallback
        const response = await withObservedSpan(
          ctx,
          'agents.model.generate',
          { agent: config.name, stepIndex: stepIdx, mode: 'stream-fallback' },
          () => model.generate(ctx, {
            messages: streamGenerateMessages,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
            toolChoice: toolDefs.length > 0 ? 'auto' : undefined,
            ...(opts.outputSchema && { responseFormat: opts.outputSchema }),
          }),
        );

        totalPromptTokens += response.usage.promptTokens;
        totalCompletionTokens += response.usage.completionTokens;

        if (response.toolCalls && response.toolCalls.length > 0) {
          messages.push({ role: 'assistant', content: response.content || '', toolCalls: response.toolCalls });

          // P2-1: Parallel tool execution in fallback path.
          if (streamParallel) {
            for (const tc of response.toolCalls) {
              yield { type: 'tool_start', step: { index: steps.length, type: 'tool_call', content: tc.name, durationMs: 0 } };
            }
            const toolResults = await Promise.all(
              response.toolCalls.map((tc) =>
                executeToolCall(ctx, tc, toolReg, policy, eventBus, config.name, stepIdx, stepStart, streamToolRetryOpts, streamInterruptOpts, streamPendingHandoffFeedback),
              ),
            );
            for (let i = 0; i < response.toolCalls.length; i++) {
              steps.push(toolResults[i]!);
              toolCallCount++;
              messages.push({ role: 'tool', content: toolResults[i]!.toolCall?.result ?? '', toolCallId: response.toolCalls[i]!.id });
              yield { type: 'tool_end', step: toolResults[i]! };
            }
          } else {
            for (const tc of response.toolCalls) {
              yield { type: 'tool_start', step: { index: steps.length, type: 'tool_call', content: tc.name, durationMs: 0 } };
              const toolStep = await executeToolCall(ctx, tc, toolReg, policy, eventBus, config.name, stepIdx, stepStart, streamToolRetryOpts, streamInterruptOpts, streamPendingHandoffFeedback);
              steps.push(toolStep);
              toolCallCount++;
              messages.push({ role: 'tool', content: toolStep.toolCall?.result ?? '', toolCallId: tc.id });
              yield { type: 'tool_end', step: toolStep };
            }
          }
          continue;
        }

        // P2-2: Validate structured output before post-processing in fallback path.
        if (opts.outputSchema && !isExpired(ctx)) {
          const soResult = validateStructuredOutput(response.content, opts.outputSchema);
          if (soResult.valid) {
            streamStructuredOutputParsed = soResult.parsed;
          } else if (streamStructuredOutputRetryCount < (opts.structuredOutputRetries ?? 1)) {
            streamStructuredOutputRetryCount++;
            messages.push({ role: 'assistant', content: response.content });
            messages.push({
              role: 'user',
              content: `Your response must be valid JSON${opts.outputSchema.name ? ` conforming to schema "${opts.outputSchema.name}"` : ''}. Please respond with valid JSON only and no surrounding text.`,
            });
            continue;
          }
        }

        // ── H-18: fallback terminal — same post-processor as streaming path ──
        const fallbackUsage = { prompt: response.usage.promptTokens, completion: response.usage.completionTokens };
        const fallbackTerminal = await processTerminalResponse({
          ctx, model, rawContent: response.content, agentName: config.name,
          messages, steps, stepStart, tokenUsage: fallbackUsage,
          verifyOpts: opts.verify, reflectOpts: opts.reflect,
          verifyAttemptCount: streamVerifyAttemptCount,
          revisionCount: streamRevisionCount,
          resolvedCritic: streamResolvedCritic,
          guardrailDenied: streamGuardrailDenied,
        });
        streamVerifyAttemptCount = fallbackTerminal.verifyAttemptCount;
        streamRevisionCount = fallbackTerminal.revisionCount;
        streamResolvedCritic = fallbackTerminal.resolvedCritic;
        streamGuardrailDenied = fallbackTerminal.guardrailDenied;

        if (fallbackTerminal.result.action === 'continue') {
          for (const ev of fallbackTerminal.result.events) yield ev;
          messages.push(...fallbackTerminal.result.appendMessages);
          continue;
        }

        const responseStep: AgentStep = {
          index: steps.length,
          type: 'response',
          content: fallbackTerminal.result.finalContent,
          durationMs: Date.now() - stepStart,
          tokenUsage: fallbackUsage,
        };
        steps.push(responseStep);
        yield { type: 'step_end', step: responseStep };
        yield {
          type: 'done',
          result: buildResult(
            steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime,
            streamGuardrailDenied ? 'guardrail_denied' : 'completed',
            streamStructuredOutputParsed !== undefined ? { structuredOutput: streamStructuredOutputParsed } : undefined,
          ),
        };
        return;
      }

      // Reached max steps
      yield {
        type: 'done',
        result: buildResult(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, 'failed'),
      };
      } catch (err) {
        // P3-2: HandoffSignal — execute target agent and yield its result.
        if (err instanceof HandoffSignal) {
          void weaveAudit(ctx, {
            action: 'agent.handoff',
            outcome: 'success',
            resource: config.name,
            details: { from: config.name, to: err.targetName },
          });
          eventBus?.emit(weaveEvent(EventTypes.AgentDelegation, {
            from: config.name,
            to: err.targetName,
            type: 'handoff',
          }, ctx));
          const handoffResult = await err.targetAgent.run(ctx, err.transferInput);
          const handoffMeta: HandoffMetadata = {
            from: config.name,
            to: err.targetName,
            transferInput: err.transferInput.goal,
          };
          yield {
            type: 'done',
            result: {
              ...handoffResult,
              metadata: { ...handoffResult.metadata, handoff: handoffMeta },
            },
          };
          return;
        }
        throw err;
      }
    },
  };
}

// ─── Interrupt options type (internal, passed to executeToolCall) ─

interface InterruptCallOpts {
  handler: InterruptHandler;
  /** When true every tool call triggers the interrupt, not just requireApproval tools. */
  requireAll: boolean;
}

// ─── Terminal response post-processor (H-18) ─────────────────
//
// Shared by the streaming and non-streaming fallback paths inside runStream().
// Both paths do: guardrail-check → W2-verify → W1-reflect → finalize.
// The only difference is which AgentStepEvent type to yield back — the caller
// iterates `events` and yields them, then acts on `action`.

type TerminalResponseAction =
  | {
      /** Continue the step loop — verify or reflect requested a revision. */
      action: 'continue';
      /** Events to yield before looping (verify_failed / reflect_revised). */
      events: AgentStepEvent[];
      /** Messages to append before looping. */
      appendMessages: Message[];
    }
  | {
      /** Terminal: all checks passed (or were skipped). */
      action: 'done';
      finalContent: string;
      guardrailDenied: boolean;
    };

async function processTerminalResponse(opts: {
  ctx: ExecutionContext;
  model: Model;
  rawContent: string;
  agentName: string;
  messages: Message[];
  steps: AgentStep[];
  stepStart: number;
  tokenUsage: { prompt: number; completion: number };
  verifyOpts?: { verifier: { verify(ctx: ExecutionContext, content: string, meta: { userInput: string }): Promise<{ passed: boolean; reason?: string; score?: number }> }; maxAttempts?: number };
  reflectOpts?: { critic?: Critic; maxRevisions?: number; criteria?: string };
  verifyAttemptCount: number;
  revisionCount: number;
  resolvedCritic: Critic | undefined;
  guardrailDenied: boolean;
}): Promise<{
  result: TerminalResponseAction;
  verifyAttemptCount: number;
  revisionCount: number;
  resolvedCritic: Critic | undefined;
  guardrailDenied: boolean;
}> {
  let { verifyAttemptCount, revisionCount, resolvedCritic, guardrailDenied } = opts;
  const { ctx, agentName, messages, steps, stepStart, tokenUsage } = opts;

  // ── Guardrail output check ────────────────────────────────────────────────
  let finalContent = opts.rawContent;
  const outputGuardrails = ctx.runtime?.guardrails;
  if (outputGuardrails?.checkOutput) {
    let decision: { allow: boolean; redactedText?: string; reason?: string } = { allow: true };
    try {
      decision = await outputGuardrails.checkOutput(ctx, opts.rawContent);
    } catch (err) {
      decision = { allow: false, reason: `guardrails error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!decision.allow) {
      void weaveAudit(ctx, { action: 'agent.output.denied', outcome: 'denied', resource: agentName, details: { reason: decision.reason ?? 'guardrails' } });
      finalContent = `Response blocked by guardrails: ${decision.reason ?? 'no reason'}`;
      guardrailDenied = true;
    } else if (decision.redactedText !== undefined) {
      finalContent = decision.redactedText;
    }
  }

  // ── W2: verify → regenerate ───────────────────────────────────────────────
  if (opts.verifyOpts && !isExpired(ctx)) {
    const maxAttempts = opts.verifyOpts.maxAttempts ?? 1;
    if (verifyAttemptCount < maxAttempts) {
      let vr: { passed: boolean; reason?: string; score?: number };
      try {
        vr = await opts.verifyOpts.verifier.verify(ctx, finalContent, { userInput: lastUserMessage(messages) });
      } catch (err) {
        vr = { passed: false, reason: `verifier error: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!vr.passed) {
        verifyAttemptCount++;
        void weaveAudit(ctx, { action: 'agent.verify.failed', outcome: 'failure', resource: agentName, details: { attempt: verifyAttemptCount, reason: vr.reason, score: vr.score } });
        const vStep: AgentStep = { index: steps.length, type: 'thinking', content: `[verify:failed attempt=${verifyAttemptCount}] ${vr.reason ?? 'did not pass'}`, durationMs: Date.now() - stepStart, tokenUsage };
        steps.push(vStep);
        return {
          result: {
            action: 'continue',
            events: [{ type: 'verify_failed', step: vStep }],
            appendMessages: [
              { role: 'assistant', content: finalContent },
              { role: 'user', content: `Your previous response did not pass verification (${vr.reason ?? 'quality check failed'}). Please regenerate a better response.` },
            ],
          },
          verifyAttemptCount, revisionCount, resolvedCritic, guardrailDenied,
        };
      }
    }
  }

  // ── W1: reflect → revise ─────────────────────────────────────────────────
  if (opts.reflectOpts && !isExpired(ctx)) {
    const maxRevisions = opts.reflectOpts.maxRevisions ?? 1;
    if (revisionCount < maxRevisions) {
      if (!resolvedCritic) {
        resolvedCritic = opts.reflectOpts.critic ?? await buildDefaultCritic(opts.model, opts.reflectOpts.criteria);
      }
      let cr: { accepted: boolean; feedback?: string; score?: number };
      try {
        cr = await resolvedCritic.critique(ctx, lastUserMessage(messages), finalContent);
      } catch (err) {
        cr = { accepted: false, feedback: `critic error: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!cr.accepted) {
        revisionCount++;
        void weaveAudit(ctx, { action: 'agent.reflect.revise', outcome: 'success', resource: agentName, details: { revision: revisionCount, score: cr.score, feedback: cr.feedback } });
        const rStep: AgentStep = { index: steps.length, type: 'thinking', content: `[reflect:revision=${revisionCount}] ${cr.feedback ?? 'critique requested revision'}`, durationMs: Date.now() - stepStart, tokenUsage };
        steps.push(rStep);
        return {
          result: {
            action: 'continue',
            events: [{ type: 'reflect_revised', step: rStep }],
            appendMessages: [
              { role: 'assistant', content: finalContent },
              { role: 'user', content: `Please revise your response based on this feedback: ${cr.feedback ?? 'Improve the quality of your answer.'}` },
            ],
          },
          verifyAttemptCount, revisionCount, resolvedCritic, guardrailDenied,
        };
      }
      void weaveAudit(ctx, { action: 'agent.reflect.accepted', outcome: 'success', resource: agentName, details: { revision: revisionCount, score: cr.score } });
    }
  }

  return {
    result: { action: 'done', finalContent, guardrailDenied },
    verifyAttemptCount, revisionCount, resolvedCritic, guardrailDenied,
  };
}

// ─── Tool execution helper ───────────────────────────────────

async function executeToolCall(
  ctx: ExecutionContext,
  tc: ToolCall,
  toolReg: ToolRegistry,
  policy: AgentPolicy | undefined,
  eventBus: EventBus | undefined,
  agentName: string,
  stepIdx: number,
  stepStart: number,
  retryOpts?: { maxAttempts?: number; backoffMs?: number; maxBackoffMs?: number },
  interruptOpts?: InterruptCallOpts,
  pendingFeedback?: string[],
  complianceOpts?: ToolCallingAgentOptions['complianceTools'],
): Promise<AgentStep> {
  const tool = toolReg.get(tc.name);
  const toolName = tc.name;
  const guardrails = ctx.runtime?.guardrails;

  eventBus?.emit(weaveEvent(EventTypes.ToolCallStart, { tool: toolName, agent: agentName }, ctx));

  let resultContent: string;

  if (!tool) {
    resultContent = `Error: Tool "${tc.name}" not found. Available tools: ${toolReg.list().map((t) => t.schema.name).join(', ')}`;
    void weaveAudit(ctx, { action: 'agent.tool.invoke', outcome: 'failure', resource: toolName, details: { agent: agentName, reason: 'not_found' } });
  } else {
    // Ambient guardrails (Phase 3): preferred over the legacy per-agent
    // `policy.approveToolCall` so cross-cutting policy can live on the
    // runtime and apply uniformly across every agent in the process.
    if (guardrails?.checkToolCall) {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(tc.arguments) as Record<string, unknown>; } catch { /* keep empty */ }
      let decision: { allow: boolean; reason?: string } = { allow: true };
      try {
        decision = await guardrails.checkToolCall(ctx, tool.schema, parsed);
      } catch (err) {
        // Guardrails throwing means *fail closed* + audit; agents must
        // never silently bypass an erroring policy check.
        decision = { allow: false, reason: `guardrails error: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!decision.allow) {
        resultContent = `Tool call denied by guardrails: ${decision.reason ?? 'no reason'}`;
        eventBus?.emit(weaveEvent(EventTypes.ToolCallError, { tool: toolName, reason: 'guardrails_denied' }, ctx));
        void weaveAudit(ctx, { action: 'agent.tool.invoke', outcome: 'denied', resource: toolName, details: { agent: agentName, reason: decision.reason ?? 'guardrails' } });
        return {
          index: 0,
          type: 'tool_call',
          toolCall: { name: toolName, arguments: parsed, result: resultContent },
          durationMs: Date.now() - stepStart,
        };
      }
    }

    // P6-4: Compliance gate — check consent before tool execution.
    if (complianceOpts && ctx.runtime?.compliance) {
      const subjectId = complianceOpts.subjectId;
      const purpose = complianceOpts.purpose ?? 'agent.tool.execute';
      const dataClass = complianceOpts.dataClassifications?.[toolName];
      const enforce = complianceOpts.enforceConsent !== false;

      if (subjectId) {
        let consentGranted = true;
        try {
          consentGranted = await ctx.runtime.compliance.isAllowed(subjectId, purpose);
        } catch {
          consentGranted = !enforce; // fail-open unless enforcing
        }

        void weaveAudit(ctx, {
          action: 'agent.tool.compliance',
          outcome: consentGranted ? 'success' : 'denied',
          resource: toolName,
          details: {
            agent: agentName,
            subjectId,
            purpose,
            ...(dataClass ? { dataClassification: dataClass } : {}),
            consent: consentGranted,
          },
        });

        if (!consentGranted && enforce) {
          resultContent = `Tool call denied: consent not granted for purpose "${purpose}" (subject: ${subjectId})`;
          eventBus?.emit(weaveEvent(EventTypes.ToolCallError, { tool: toolName, reason: 'compliance_denied' }, ctx));
          return {
            index: 0,
            type: 'tool_call',
            toolCall: { name: toolName, arguments: {}, result: resultContent },
            durationMs: Date.now() - stepStart,
          };
        }
      }
    }

    // Legacy per-agent policy hook — still honoured for backwards compat.
    // H-11: use safeParseJson so a malformed arguments string from the model
    // does not throw an unhandled exception that bypasses the denial logic.
    // On parse failure, block the tool call and return an error result — it is
    // safer to deny a call with unparseable arguments than to let it through.
    if (policy?.approveToolCall) {
      let policyArgs: Record<string, unknown>;
      try {
        policyArgs = JSON.parse(tc.arguments) as Record<string, unknown>;
      } catch (parseErr) {
        // Arguments string is invalid JSON — block the call rather than crash.
        const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        resultContent = `Tool call blocked: could not parse tool arguments — ${errMsg}`;
        eventBus?.emit(weaveEvent(EventTypes.ToolCallError, { tool: toolName, reason: 'invalid_arguments' }, ctx));
        void weaveAudit(ctx, { action: 'agent.tool.invoke', outcome: 'denied', resource: toolName, details: { agent: agentName, reason: 'invalid_arguments', raw: tc.arguments.slice(0, 200) } });
        return {
          index: 0,
          type: 'tool_call',
          toolCall: { name: toolName, arguments: { _raw: tc.arguments }, result: resultContent },
          durationMs: Date.now() - stepStart,
        };
      }
      const decision = await policy.approveToolCall(ctx, tool.schema, policyArgs);
      if (!decision.approved) {
        resultContent = `Tool call denied by policy: ${decision.reason ?? 'no reason'}`;
        eventBus?.emit(weaveEvent(EventTypes.ToolCallError, { tool: toolName, reason: 'policy_denied' }, ctx));
        void weaveAudit(ctx, { action: 'agent.tool.invoke', outcome: 'denied', resource: toolName, details: { agent: agentName, reason: decision.reason ?? 'policy' } });
        return {
          index: 0,
          type: 'tool_call',
          toolCall: { name: toolName, arguments: policyArgs, result: resultContent },
          durationMs: Date.now() - stepStart,
        };
      }
    }

    // P3-1: HITL interrupt check — fires when:
    //   a) onInterrupt is configured AND
    //   b) either requireAll is true (every tool) OR the tool schema has requireApproval
    // The check happens after guardrails (automated policy) and before execution.
    const toolRequiresApproval =
      interruptOpts &&
      (interruptOpts.requireAll ||
        (tool.schema as { requireApproval?: boolean }).requireApproval === true);

    if (toolRequiresApproval && interruptOpts) {
      let interruptArgs: Record<string, unknown> = {};
      try { interruptArgs = JSON.parse(tc.arguments) as Record<string, unknown>; } catch { /* keep empty */ }

      const interruptEvent: InterruptEvent = {
        type: 'tool_approval',
        toolName,
        toolArgs: interruptArgs,
        reason: `Tool "${toolName}" requires human approval before execution.`,
        agentStep: stepIdx,
        agentName,
      };

      let resolution;
      try {
        resolution = await interruptOpts.handler(ctx, interruptEvent);
      } catch (err) {
        // Handler threw — fail closed
        resolution = {
          action: 'reject' as const,
          feedback: `Interrupt handler error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      void weaveAudit(ctx, {
        action: 'agent.interrupt.decision',
        outcome: resolution.action === 'approve' ? 'success' : 'failure',
        resource: toolName,
        details: { agentName, action: resolution.action },
      });

      if (resolution.action === 'reject') {
        resultContent = `Tool call rejected by human reviewer: ${resolution.feedback ?? 'no reason given'}`;
        eventBus?.emit(weaveEvent(EventTypes.ToolCallError, { tool: toolName, reason: 'hitl_rejected' }, ctx));
        void weaveAudit(ctx, { action: 'agent.tool.invoke', outcome: 'denied', resource: toolName, details: { agent: agentName, reason: 'hitl_rejected' } });
        if (resolution.feedback && pendingFeedback) {
          pendingFeedback.push(`[HITL feedback for ${toolName}]: ${resolution.feedback}`);
        }
        return {
          index: 0,
          type: 'tool_call',
          toolCall: { name: toolName, arguments: interruptArgs, result: resultContent },
          durationMs: Date.now() - stepStart,
        };
      }

      if (resolution.action === 'modify' && resolution.modifiedArgs) {
        // Merge modified args back into tc.arguments so the tool receives them.
        tc = { ...tc, arguments: JSON.stringify({ ...interruptArgs, ...resolution.modifiedArgs }) };
        if (resolution.feedback && pendingFeedback) {
          pendingFeedback.push(`[HITL modification for ${toolName}]: ${resolution.feedback}`);
        }
      } else if (resolution.feedback && pendingFeedback) {
        pendingFeedback.push(`[HITL approval feedback for ${toolName}]: ${resolution.feedback}`);
      }
    }

    try {
      const args = JSON.parse(tc.arguments);
      const maxAttempts = retryOpts?.maxAttempts ?? 1;
      const backoffMs = retryOpts?.backoffMs ?? 200;
      const maxBackoffMs = retryOpts?.maxBackoffMs ?? 10_000;
      let lastErr: unknown;
      let output: { content: string; isError?: boolean } | undefined;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          await backoffDelay(attempt, backoffMs, maxBackoffMs);
        }
        try {
          output = await withObservedSpan(
            ctx,
            'agents.tool.invoke',
            { agent: agentName, tool: toolName, attempt },
            () => tool.invoke(ctx, { name: toolName, arguments: args }),
          );
          lastErr = undefined;
          break; // success
        } catch (err) {
          lastErr = err;
          // P3-2: HandoffSignal must always propagate — never retry or swallow it.
          if (err instanceof HandoffSignal) throw err;
          // Only retry on transient errors; propagate non-transient immediately.
          if (!isTransientError(err)) throw err;
        }
      }

      if (lastErr !== undefined) {
        throw lastErr;
      }

      resultContent = output!.isError ? `Error: ${output!.content}` : output!.content;
      void weaveAudit(ctx, {
        action: 'agent.tool.invoke',
        outcome: output!.isError ? 'failure' : 'success',
        resource: toolName,
        details: { agent: agentName },
      });
    } catch (err) {
      // P3-2: HandoffSignal must propagate to the agent loop — never swallow it.
      if (err instanceof HandoffSignal) throw err;
      resultContent = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
      void weaveAudit(ctx, { action: 'agent.tool.invoke', outcome: 'failure', resource: toolName, details: { agent: agentName, error: err instanceof Error ? err.message : String(err) } });
    }
  }

  eventBus?.emit(weaveEvent(EventTypes.ToolCallEnd, { tool: toolName, agent: agentName, result: resultContent }, ctx));

  return {
    index: 0,
    type: 'tool_call',
    toolCall: { name: toolName, arguments: safeParseJson(tc.arguments), result: resultContent },
    durationMs: Date.now() - stepStart,
  };
}

function safeParseJson(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str) as Record<string, unknown>;
  } catch {
    return { _raw: str };
  }
}

// ─── Result builders ─────────────────────────────────────────

function buildUsage(
  steps: AgentStep[],
  promptTokens: number,
  completionTokens: number,
  toolCallCount: number,
  startTime: number,
): AgentUsage {
  return {
    totalSteps: steps.length,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    totalDurationMs: Date.now() - startTime,
    toolCalls: toolCallCount,
    delegations: steps.filter((s) => s.type === 'delegation').length,
  };
}

function buildResult(
  steps: AgentStep[],
  promptTokens: number,
  completionTokens: number,
  toolCallCount: number,
  startTime: number,
  status: AgentResult['status'],
  metadata?: Record<string, unknown>,
): AgentResult {
  const lastResponse = [...steps].reverse().find((s) => s.type === 'response');
  return {
    output: lastResponse?.content ?? '',
    messages: [],
    steps,
    usage: buildUsage(steps, promptTokens, completionTokens, toolCallCount, startTime),
    status,
    ...(metadata !== undefined && { metadata }),
  };
}

/** Extract the most recent user-role message content from the conversation. */
function lastUserMessage(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return String(messages[i]!.content);
  }
  return '';
}

// ─── P5-1: Resume from checkpoint ────────────────────────────

/**
 * Build an `Agent` that resumes from a previously saved `AgentCheckpoint`.
 *
 * The checkpoint's full conversation history is injected before the caller's
 * new `input.messages`, so the agent continues the ReAct loop from exactly
 * where it left off. The system message is stripped from the checkpoint
 * history (to avoid duplication) when `agentOpts.systemPrompt` is set.
 *
 * The resumed agent carries the same `ToolCallingAgentOptions` as the
 * original, including any checkpoint store — so it will keep saving
 * incremental checkpoints under the same `runId`.
 *
 * @param checkpoint  Loaded from `CheckpointStore.load(runId)`.
 * @param agentOpts   Same options used to create the original agent.
 */
export function resumeFromCheckpoint(
  checkpoint: AgentCheckpoint,
  agentOpts: ToolCallingAgentOptions,
): Agent {
  // Strip the first message if it's a system message AND the new agent will
  // add its own system prompt — avoids duplicate system blocks.
  const hasSystemPrompt = Boolean(
    agentOpts.systemPrompt ||
    agentOpts.workers?.length ||
    agentOpts.workerRegistry,
  );
  const resumeHistory = hasSystemPrompt && checkpoint.messages[0]?.role === 'system'
    ? checkpoint.messages.slice(1)
    : checkpoint.messages;

  // Always resume under the same runId so all checkpoints share one lineage.
  const resumeOpts: ToolCallingAgentOptions = {
    ...agentOpts,
    checkpoint: agentOpts.checkpoint
      ? { ...agentOpts.checkpoint, runId: checkpoint.runId }
      : undefined,
  };

  const inner = weaveAgent(resumeOpts);

  return {
    config: inner.config,
    async run(ctx, input) {
      const mergedInput: AgentInput = {
        ...input,
        messages: [...resumeHistory, ...input.messages],
      };
      return inner.run(ctx, mergedInput);
    },
    async *runStream(ctx, input) {
      const mergedInput: AgentInput = {
        ...input,
        messages: [...resumeHistory, ...input.messages],
      };
      if (inner.runStream) {
        yield* inner.runStream(ctx, mergedInput);
      } else {
        // Non-streaming fallback: run and emit a single text_chunk.
        const result = await inner.run(ctx, mergedInput);
        if (result.output) {
          yield { type: 'text_chunk', text: result.output };
        }
        yield { type: 'done', result };
      }
    },
  };
}
