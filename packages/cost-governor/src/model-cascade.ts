/**
 * Phase 4 — Model Cascade (lever L1).
 *
 * Replaces the no-op `modelResolver` stub from Phase 2 with a real
 * decision engine that picks **cheap-by-default** and **escalates to
 * expensive** when a configured rule fires. The escalation rules are
 * pure data on `ResolvedCostPolicy.modelCascade.escalateOn` so operators
 * can tune them per-tier from the admin UI without code changes.
 *
 * The package contributes three primitives:
 *
 *   1. `RunCostStateTracker`        — per-run signal aggregator
 *      (in-memory, opt-in). The runtime reports tool-call outcomes,
 *      JSON-parse outcomes, current step kind, and intel score; the
 *      cascade decision reads from it.
 *
 *   2. `decideCascadeModel(...)`    — pure decision returning
 *      `{ choice: 'cheap' | 'expensive' | 'pass-through', triggerRule? }`.
 *      No state, no IO — easy to test.
 *
 *   3. `weaveModelCascadeResolver(opts)` — runtime adapter. Wraps a
 *      base resolver (structurally compatible with the live-agents
 *      `ModelResolver` interface — defined locally as
 *      `ModelResolverLike` so this package stays dep-free). On every
 *      `resolve(ctx)` it consults the cost policy + run state, and
 *      either materialises the cascade pick via a caller-supplied
 *      `loadModel(ref)` or falls through to the base resolver.
 *
 * Plus a fourth helper for runtime instrumentation:
 *
 *   4. `wrapAuditEmitterWithCascadeTracker(inner, tracker, opts)` —
 *      drop-in audit emitter wrapper that increments
 *      `tool_call_failed_count` whenever a tool invocation errors.
 *      The cascade resolver then sees the bumped counter on the next
 *      `decideCascadeModel` call and can escalate the next tick.
 *
 * Reusability invariant: this file imports ONLY from `@weaveintel/core`
 * (for `Model` + `ModelInfo`) and `./policy.js`. No live-agents, no DB,
 * no provider deps. Any consumer that has a model-resolution seam (a
 * `ModelResolverLike`) and a way to load a `Model` from a `ModelRef`
 * can adopt this lever.
 */

import type { Model, ToolAuditEvent } from '@weaveintel/core';
import type {
  EscalationRule,
  ModelCascadeConfig,
  ModelRef,
} from './policy.js';
import type { ToolAuditEmitter } from '@weaveintel/tools';

// ---------------------------------------------------------------------------
// ModelResolverLike — local structural copy of the live-agents interface
// so we never import @weaveintel/live-agents.
// ---------------------------------------------------------------------------

/**
 * Per-tick context handed to the cascade resolver. Field set is the
 * intersection of `ModelResolverContext` (live-agents) and the runtime
 * info we need to drive the cascade decision.
 */
export interface CascadeResolverContext {
  role?: string;
  capability?: { task?: string; hints?: Record<string, unknown> } | undefined;
  agentId?: string;
  meshId?: string;
  tenantId?: string;
  /** Logical run id. When set, the cascade reads per-run state from the tracker. */
  runId?: string;
  stepId?: string | number;
  /**
   * Optional explicit step kind override (e.g. `'final_answer'`). When
   * set, takes precedence over the tracker's last-seen step. Used by
   * runtimes that classify steps before the model call.
   */
  stepKind?: string;
  /**
   * Optional explicit intel score override (0..1). When set, takes
   * precedence over the tracker's stored value.
   */
  intelScore?: number;
}

export interface ModelResolverLike {
  resolve(ctx: CascadeResolverContext): Promise<Model | undefined> | Model | undefined;
}

// ---------------------------------------------------------------------------
// 1. Per-run state + tracker
// ---------------------------------------------------------------------------

/** Per-run signals the cascade decision reads. All counters monotonic. */
export interface RunCostState {
  toolCallFailedCount: number;
  jsonParseFailedCount: number;
  /** Most recently observed step kind. `undefined` until set. */
  currentStepKind?: string;
  /** Most recently observed intel score (0..1). `undefined` until set. */
  intelScore?: number;
  /** Total resolve() calls observed for this run (debug/telemetry). */
  resolveCount: number;
}

function emptyState(): RunCostState {
  return {
    toolCallFailedCount: 0,
    jsonParseFailedCount: 0,
    resolveCount: 0,
  };
}

/**
 * In-memory, per-supervisor tracker. Safe to share across ticks of
 * different agents in the same supervisor — state is keyed by `runId`.
 *
 * Best-effort: when a runId is unknown, signals are silently dropped.
 * Operators relying on the cascade MUST ensure their runtime stamps
 * `ctx.runId` on the resolver context (and on audit-event metadata
 * when wrapping the emitter).
 */
export class RunCostStateTracker {
  private readonly states = new Map<string, RunCostState>();
  /** When set, runs older than this many ms are evicted on access. 0 = never. */
  private readonly ttlMs: number;
  private readonly lastTouched = new Map<string, number>();

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? 0;
  }

  /** Read-only snapshot for a run. Returns `null` when unknown. */
  get(runId: string): RunCostState | null {
    this.maybeEvict();
    const s = this.states.get(runId);
    return s ? { ...s } : null;
  }

  /** Get-or-create state for a run. Used internally and by tests. */
  ensure(runId: string): RunCostState {
    this.maybeEvict();
    let s = this.states.get(runId);
    if (!s) {
      s = emptyState();
      this.states.set(runId, s);
    }
    this.lastTouched.set(runId, Date.now());
    return s;
  }

  /** Bump the tool-call failure counter. */
  recordToolCall(runId: string, outcome: { ok: boolean }): void {
    if (outcome.ok) return;
    this.ensure(runId).toolCallFailedCount += 1;
  }

  /** Bump the JSON-parse failure counter. */
  recordJsonParse(runId: string, outcome: { ok: boolean }): void {
    if (outcome.ok) return;
    this.ensure(runId).jsonParseFailedCount += 1;
  }

  /** Update the most-recent step kind. */
  setCurrentStep(runId: string, kind: string): void {
    this.ensure(runId).currentStepKind = kind;
  }

  /** Update the most-recent intel score (0..1). */
  setIntelScore(runId: string, score: number): void {
    this.ensure(runId).intelScore = score;
  }

  /** Increment the resolve counter (used internally by the cascade resolver). */
  noteResolve(runId: string): void {
    this.ensure(runId).resolveCount += 1;
  }

  /** Drop state for a run (call on run completion to free memory). */
  forget(runId: string): void {
    this.states.delete(runId);
    this.lastTouched.delete(runId);
  }

  /** Total runs currently tracked (for telemetry). */
  size(): number {
    return this.states.size;
  }

  private maybeEvict(): void {
    if (this.ttlMs <= 0) return;
    const cutoff = Date.now() - this.ttlMs;
    for (const [runId, ts] of this.lastTouched) {
      if (ts < cutoff) {
        this.states.delete(runId);
        this.lastTouched.delete(runId);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Pure decision
// ---------------------------------------------------------------------------

export type CascadeChoice = 'cheap' | 'expensive' | 'pass-through';

export interface CascadeDecision {
  /** Which arm of the cascade to pick. `'pass-through'` means defer to base. */
  readonly choice: CascadeChoice;
  /** When `choice === 'expensive'`, the rule that fired. */
  readonly triggerRule?: EscalationRule;
  /** When `choice !== 'pass-through'`, the model ref the runtime should load. */
  readonly modelRef?: ModelRef;
}

/**
 * Pure decision: given the cascade config, the per-run state, and the
 * per-tick context, decide which arm to pick.
 *
 * Logic:
 *   - If neither `cheap` nor `expensive` is set → `pass-through`.
 *   - If any rule in `escalateOn` evaluates true against the state →
 *     `expensive` (when set; falls back to `pass-through` if not).
 *   - Otherwise → `cheap` (when set; falls back to `pass-through` if not).
 */
export function decideCascadeModel(
  config: ModelCascadeConfig | undefined,
  state: RunCostState | null | undefined,
  ctx: CascadeResolverContext,
): CascadeDecision {
  if (!config) return { choice: 'pass-through' };
  const cheap = config.cheap;
  const expensive = config.expensive;
  if (!cheap && !expensive) return { choice: 'pass-through' };

  const effectiveState: RunCostState = state
    ? { ...state }
    : emptyState();
  // Per-tick overrides win over tracker state.
  if (ctx.stepKind !== undefined) effectiveState.currentStepKind = ctx.stepKind;
  if (ctx.intelScore !== undefined) effectiveState.intelScore = ctx.intelScore;

  const fired = (config.escalateOn ?? []).find((rule) =>
    evaluateEscalationRule(rule, effectiveState),
  );
  if (fired && expensive) {
    return { choice: 'expensive', triggerRule: fired, modelRef: expensive };
  }
  if (cheap) return { choice: 'cheap', modelRef: cheap };
  if (expensive) return { choice: 'expensive', modelRef: expensive };
  return { choice: 'pass-through' };
}

/**
 * Pure single-rule predicate. Exported so callers can build custom
 * decision pipelines without the full cascade resolver.
 */
export function evaluateEscalationRule(
  rule: EscalationRule,
  state: RunCostState,
): boolean {
  switch (rule.kind) {
    case 'tool_call_failed_count':
      return state.toolCallFailedCount >= (rule.threshold ?? 1);
    case 'json_parse_failed_count':
      return state.jsonParseFailedCount >= (rule.threshold ?? 1);
    case 'step_kind': {
      const cur = state.currentStepKind;
      if (!cur) return false;
      return (rule.stepKinds ?? []).includes(cur);
    }
    case 'intel_score_below': {
      const sc = state.intelScore;
      if (sc === undefined) return false;
      return sc < (rule.threshold ?? 0);
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// 3. Runtime adapter — wraps a ModelResolverLike with cascade behaviour
// ---------------------------------------------------------------------------

export interface WeaveModelCascadeResolverOptions {
  /** Base resolver consulted on `'pass-through'` decisions. */
  readonly base: ModelResolverLike;
  /**
   * Per-tick resolver returning the active cascade config. Returning
   * `null` is the same as `pass-through` (no cascade for this tick).
   */
  readonly resolveConfig: (
    ctx: CascadeResolverContext,
  ) => Promise<ModelCascadeConfig | null> | ModelCascadeConfig | null;
  /**
   * Materialise a `ModelRef` into a runnable `Model`. Typically thin
   * wrapper around the consumer's existing `getOrCreateModel(provider, modelId)`.
   * Returning `undefined` falls through to the base resolver (the
   * cascade is never load-bearing — failures degrade gracefully).
   */
  readonly loadModel: (ref: ModelRef) => Promise<Model | undefined> | Model | undefined;
  /** Per-run state source. When omitted, decisions see empty state. */
  readonly tracker?: RunCostStateTracker;
  /** Best-effort log sink for escalation events. */
  readonly log?: (msg: string) => void;
}

/**
 * Returns a cascade-aware `ModelResolverLike` that:
 *   1. Reads cascade config + per-run state.
 *   2. Picks cheap | expensive | pass-through via `decideCascadeModel`.
 *   3. Loads the chosen `ModelRef` via `loadModel`, or falls back to
 *      the base resolver on `pass-through` / `loadModel` failure.
 *
 * All errors thrown by `resolveConfig` and `loadModel` are caught and
 * treated as `pass-through` so caching, ledger, and other downstream
 * wrappers always see a Model when one is available.
 */
export function weaveModelCascadeResolver(
  opts: WeaveModelCascadeResolverOptions,
): ModelResolverLike {
  return {
    async resolve(ctx) {
      // 1. Read config (best-effort).
      let config: ModelCascadeConfig | null = null;
      try {
        const v = await opts.resolveConfig(ctx);
        config = v ?? null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        opts.log?.(`[cost-cascade] resolveConfig threw: ${msg}`);
      }

      // 2. Read state (when runId + tracker are both set).
      const state =
        ctx.runId && opts.tracker ? opts.tracker.get(ctx.runId) : null;
      if (ctx.runId && opts.tracker) opts.tracker.noteResolve(ctx.runId);

      // 3. Decide.
      const decision = decideCascadeModel(config ?? undefined, state, ctx);

      // 4. Materialise.
      if (decision.choice !== 'pass-through' && decision.modelRef) {
        try {
          const m = await opts.loadModel(decision.modelRef);
          if (m) {
            if (decision.triggerRule) {
              opts.log?.(
                `[cost-cascade] escalate → ${decision.modelRef.modelId} ` +
                  `(rule=${decision.triggerRule.kind}` +
                  (decision.triggerRule.threshold !== undefined
                    ? ` threshold=${decision.triggerRule.threshold}`
                    : '') +
                  ')',
              );
            }
            return m;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          opts.log?.(
            `[cost-cascade] loadModel(${decision.modelRef.modelId}) threw: ${msg}`,
          );
        }
      }

      // 5. Fall through.
      return opts.base.resolve(ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Audit-emitter wrapper — feeds tool-call signals into the tracker
// ---------------------------------------------------------------------------

export interface WrapAuditEmitterWithCascadeTrackerOptions {
  /**
   * Map an audit event to a `runId` for the tracker. Return `null` to
   * skip (event not associated with a tracked run). Typical impl looks
   * up `event.metadata?.runId` or maps `event.chatId`/`event.agentPersona`
   * to a known live-run id.
   */
  readonly resolveRunId: (event: ToolAuditEvent) => string | null;
  /**
   * Outcomes that count as failures for the tracker. Default: `['error']`.
   * `'denied'` is excluded by default because policy denials are not
   * agent mistakes; operators can override.
   */
  readonly failureOutcomes?: ReadonlyArray<string>;
}

/**
 * Drop-in audit emitter wrapper that increments
 * `RunCostStateTracker.toolCallFailedCount` on every failed tool
 * invocation. The wrapped emitter is otherwise unchanged — it forwards
 * every event to `inner.emit(event)` first (best-effort) and only then
 * updates the tracker, so audit persistence is never blocked.
 */
export function wrapAuditEmitterWithCascadeTracker(
  inner: ToolAuditEmitter,
  tracker: RunCostStateTracker,
  opts: WrapAuditEmitterWithCascadeTrackerOptions,
): ToolAuditEmitter {
  const failures = new Set(opts.failureOutcomes ?? ['error']);
  return {
    async emit(event: ToolAuditEvent): Promise<void> {
      try {
        await inner.emit(event);
      } catch {
        /* swallow — never block on inner audit failure */
      }
      try {
        const runId = opts.resolveRunId(event);
        if (!runId) return;
        const ok = !failures.has(event.outcome);
        tracker.recordToolCall(runId, { ok });
      } catch {
        /* swallow */
      }
    },
  };
}
