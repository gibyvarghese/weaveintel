/**
 * Phase 2 — `weaveDbModelResolver`: DB-backed `ModelResolver` for live-agents.
 *
 * This is the runtime-package companion to the in-memory `weaveModelResolver`
 * shipped from `@weaveintel/live-agents` in Phase 1. It lifts the per-tick
 * routing pattern previously hand-written inside geneweave's kaggle
 * heartbeat (see `apps/geneweave/src/live-agents/kaggle/heartbeat-runner.ts`)
 * into a reusable resolver any live-agents app can wire in.
 *
 * --- Why dependency injection ---
 *
 * The plan (`docs/live-agents/LLM_FIRST_CLASS_CAPABILITY_PLAN.md` §3 Phase 2)
 * is explicit: "no geneweave dependency leaks into the package". The
 * resolver therefore takes the routing brain (`routeModel`), the model
 * factory (`getOrCreateModel`), and the candidate enumerator
 * (`listCandidates`) as plain function injections. Geneweave (or any other
 * host) supplies its own implementations; tests inject deterministic fakes.
 *
 * --- Resolution order per tick ---
 *
 *   1. `listCandidates(ctx)`     — host enumerates eligible (provider,modelId)
 *      pairs from its DB / config. Empty list → return `undefined` (caller
 *      falls back to pinned `model` per Phase 1's `resolveModelForTick`).
 *   2. `routeModel(candidates, routingHints)` — host runs its routing brain
 *      (typically `@weaveintel/routing`'s SmartModelRouter). `null` →
 *      return `undefined`.
 *   3. `getOrCreateModel(provider, modelId)` — host instantiates the
 *      concrete `Model`. Throw → caller logs and falls back.
 *   4. (optional) tag the model with `id = "<provider>/<modelId>"` so
 *      per-tick logs identify which one was picked.
 *
 * --- Role → task mapping ---
 *
 * Most apps want a sensible default `taskType` per role (strategist →
 * reasoning, validator → analysis, …). Pass `roleTaskMap` to express that
 * once instead of repeating it in every call site. The per-tick
 * `ctx.capability?.task` always wins over the role default.
 *
 * @example basic usage
 * ```ts
 * import { weaveDbModelResolver } from '@weaveintel/live-agents-runtime';
 *
 * const resolver = weaveDbModelResolver({
 *   listCandidates: async () => [{ id: 'gpt-4o', provider: 'openai' }],
 *   routeModel: async (cands, hints) => ({ provider: cands[0].provider, modelId: cands[0].id }),
 *   getOrCreateModel: async (provider, modelId) => myModelFactory(provider, modelId),
 *   roleTaskMap: { strategist: 'reasoning', validator: 'analysis' },
 *   log: (msg) => console.log('[router]', msg),
 * });
 *
 * const handler = createAgenticTaskHandler({
 *   name: 'strategist',
 *   modelResolver: resolver,    // <-- per-tick routing
 *   model: pinnedFallback,      // <-- safety net
 *   prepare: async () => ({ systemPrompt: '...', userGoal: '...' }),
 * });
 * ```
 */

import type { Model } from '@weaveintel/core';
import type { ModelResolver, ModelResolverContext } from '@weaveintel/live-agents';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A `(provider, modelId)` pair the resolver can route across. */
export interface ModelCandidate {
  /** Model identifier (e.g. `'gpt-4o'`, `'claude-3-5-sonnet'`). */
  id: string;
  /** Provider key (e.g. `'openai'`, `'anthropic'`). */
  provider: string;
}

/**
 * Routing hints the resolver passes to the host's `routeModel(...)` brain.
 * Mirrors the subset of `RouteModelOpts` from geneweave's chat path that is
 * relevant to live-agents per-tick selection — kept narrow so apps can
 * adapt without leaking their full routing options shape into this package.
 */
export interface DbModelRoutingHints {
  /** Task type override — wins over the role default. */
  taskType?: string;
  /** Free-form prompt label, mostly for routing-decision audit trails. */
  prompt?: string;
  /** Tenant id (for tenant-scoped routing policies). */
  tenantId?: string | null;
  /** Agent id (for routing audit / capability scoring). */
  agentId?: string | null;
}

/**
 * Result shape `routeModel` returns. Subset of geneweave's `routeModel`
 * return value — only the fields this resolver actually needs.
 */
export interface DbRoutingDecision {
  provider: string;
  modelId: string;
  /** Optional task key the router resolved (for log clarity). */
  taskKey?: string | undefined;
  /** Optional experiment label (for log clarity). */
  experimentName?: string | undefined;
}

export interface WeaveDbModelResolverOptions {
  /** Enumerate eligible candidates. Called fresh per tick so DB changes
   *  (new model_pricing rows, disabled providers, …) take effect immediately. */
  listCandidates: (ctx: ModelResolverContext) => Promise<ModelCandidate[]> | ModelCandidate[];
  /** Routing brain. Returns `null` to defer to caller's fallback. */
  routeModel: (
    candidates: ModelCandidate[],
    hints: DbModelRoutingHints,
  ) => Promise<DbRoutingDecision | null>;
  /** Build a concrete `Model` from the routing decision. */
  getOrCreateModel: (provider: string, modelId: string) => Promise<Model>;
  /**
   * Map of `role → default taskType`. The per-tick `ctx.capability?.task`
   * always wins over the role default.
   *
   * @example { strategist: 'reasoning', validator: 'analysis' }
   */
  roleTaskMap?: Record<string, string>;
  /** Default `taskType` when nothing else is specified. Defaults to `'reasoning'`. */
  defaultTaskType?: string;
  /** Optional structured logger. Defaults to no-op. */
  log?: (msg: string) => void;
  /**
   * If `true` (default), tag the resolved model with
   * `id = "<provider>/<modelId>"` so handler logs can identify it. Set
   * `false` to leave the model untouched.
   */
  tagModelId?: boolean;
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

/**
 * Build a DB-backed `ModelResolver`. The returned resolver is safe to share
 * across every agent in a mesh; routing is recomputed on every tick.
 *
 * Failure modes (resolver returns `undefined` so caller falls back to pinned):
 *   - `listCandidates` throws or returns empty
 *   - `routeModel` throws or returns null
 *   - `getOrCreateModel` throws
 *
 * In every failure case a single warn-level log line is emitted (when `log`
 * is supplied) and the per-tick `resolveModelForTick(...)` machinery
 * cleanly degrades to the pinned `model` fallback.
 */
export function weaveDbModelResolver(opts: WeaveDbModelResolverOptions): ModelResolver {
  const log = opts.log ?? (() => {});
  const tag = opts.tagModelId !== false;
  const defaultTaskType = opts.defaultTaskType ?? 'reasoning';

  return {
    async resolve(ctx: ModelResolverContext): Promise<Model | undefined> {
      // 1. Candidates
      let candidates: ModelCandidate[];
      try {
        candidates = await opts.listCandidates(ctx);
      } catch (err) {
        log(`weaveDbModelResolver: listCandidates threw — falling back. ${describeErr(err)}`);
        return undefined;
      }
      if (!candidates || candidates.length === 0) {
        log(`weaveDbModelResolver: no candidates available for role=${ctx.role ?? '?'}`);
        return undefined;
      }

      // 2. Route
      const taskType =
        ctx.capability?.task ??
        (ctx.role && opts.roleTaskMap?.[ctx.role]) ??
        defaultTaskType;
      const hints: DbModelRoutingHints = {
        taskType,
        prompt: ctx.role ? `live-agent-${ctx.role}` : 'live-agent',
        tenantId: ctx.tenantId ?? null,
        agentId: ctx.agentId ?? null,
      };
      let decision: DbRoutingDecision | null;
      try {
        decision = await opts.routeModel(candidates, hints);
      } catch (err) {
        log(`weaveDbModelResolver: routeModel threw — falling back. ${describeErr(err)}`);
        return undefined;
      }
      if (!decision) {
        log(`weaveDbModelResolver: no routing decision for role=${ctx.role ?? '?'} task=${taskType}`);
        return undefined;
      }

      // 3. Instantiate
      let model: Model;
      try {
        model = await opts.getOrCreateModel(decision.provider, decision.modelId);
      } catch (err) {
        log(
          `weaveDbModelResolver: getOrCreateModel(${decision.provider}, ${decision.modelId}) threw — ` +
            `falling back. ${describeErr(err)}`,
        );
        return undefined;
      }

      // 4. Tag for log clarity (best-effort).
      if (tag) {
        try {
          Object.defineProperty(model, 'id', {
            value: `${decision.provider}/${decision.modelId}`,
            configurable: true,
            writable: true,
          });
        } catch {
          /* non-fatal */
        }
      }

      log(
        `weaveDbModelResolver: role=${ctx.role ?? '?'} task=${taskType} → ` +
          `${decision.provider}/${decision.modelId}` +
          (decision.taskKey ? ` (taskKey=${decision.taskKey})` : '') +
          (decision.experimentName ? ` (experiment=${decision.experimentName})` : ''),
      );
      return model;
    },
  };
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
