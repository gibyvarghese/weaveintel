/**
 * Phase 1 — `ModelResolver`: first-class capability slot for *temporally
 * varying* model selection inside live-agents.
 *
 * `weaveAgent` (the one-shot, request-scoped sibling in `@weaveintel/agents`)
 * accepts a single pinned `model: Model`. Live-agents run for hours, days,
 * or weeks across many ticks, so the model that is best for a given tick
 * may change — provider rate-limits, cost ceilings, capability hints, A/B
 * routing, all want a *fresh* model selection per invocation.
 *
 * `ModelResolver` is the seam that makes per-tick selection a first-class
 * injected slot, exactly the way `model` is on `weaveAgent`. Live-agent
 * constructors accept either:
 *
 *   - `model?: Model`               — pinned (parity with weaveAgent)
 *   - `modelResolver?: ModelResolver` — per-tick (live-agents extension)
 *   - both                          — resolver takes precedence; pinned model
 *                                     is the fallback when the resolver
 *                                     returns `undefined` or throws
 *
 * This file lives in `@weaveintel/live-agents` (the temporal-extension
 * package) and intentionally has zero DB / runtime dependencies. The
 * DB-backed resolver (Phase 2 — `weaveDbModelResolver`) lives in
 * `@weaveintel/live-agents-runtime` and *consumes* this interface; it
 * never re-defines it.
 *
 * --- Naming convention (see .github/copilot-instructions.md) ---
 *   weave* — user-facing constructor that returns a runnable thing
 *   create* — internal factory that returns infrastructure plumbing
 *   `ModelResolver` is a `PascalCase` type; `weaveModelResolver` is the
 *   user-facing constructor.
 */

import type { Model } from '@weaveintel/core';
import type { ModelCapabilitySpec } from './llm/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Context handed to a `ModelResolver` on every per-tick resolution.
 *
 * Every field is optional so simple resolvers (e.g. `weaveModelResolver`)
 * can ignore the input entirely. Callers SHOULD populate as many fields
 * as they have available so DB-backed resolvers can route on role/task/run.
 */
export interface ModelResolverContext {
  /** Logical role of the agent (e.g. `'strategist'`, `'validator'`). Used
   *  by routing implementations to score candidate models. */
  role?: string;
  /** Capability hint — task type, tool-use needs, min-context, free-form
   *  routing hints. Same shape as `LiveReactLoopInput`'s budget context. */
  capability?: ModelCapabilitySpec;
  /** Live-agent identifier (for telemetry and per-agent overrides). */
  agentId?: string;
  /** Mesh identifier (for tenant-scoped routing). */
  meshId?: string;
  /** Tenant identifier (for tenant-scoped routing). */
  tenantId?: string;
  /** Run identifier (for telemetry / audit). Set by the runtime when known. */
  runId?: string;
  /** Step identifier within the current run (for telemetry / audit). */
  stepId?: string | number;
}

/**
 * First-class capability slot for per-invocation model resolution.
 *
 * Implementations MUST be safe to call concurrently from multiple ticks.
 * Implementations MAY return `undefined` to signal "no preference — use
 * the caller's fallback". Implementations MAY throw — the caller treats
 * a throw the same as `undefined` (falls back to pinned `model`) and
 * logs the error.
 */
export interface ModelResolver {
  /**
   * Resolve the model to use for the next tick.
   *
   * @param ctx Per-tick context (role, agentId, capability hint, ...).
   * @returns A `Model` to use, or `undefined` to defer to the caller's
   *          fallback. May return synchronously or via Promise.
   */
  resolve(
    ctx: ModelResolverContext,
  ): Promise<Model | undefined> | Model | undefined;
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Build a trivial pinned `ModelResolver` that always returns the same
 * `Model` instance regardless of context.
 *
 * Use for tests, examples, and as the *base* of a fallback chain when
 * composing resolvers with `composeModelResolvers`.
 *
 * @example
 * ```ts
 * const resolver = weaveModelResolver({ model: openAIModel('gpt-4o') });
 * await resolver.resolve({ role: 'strategist' }); // → the gpt-4o model
 * ```
 */
export function weaveModelResolver(opts: { model: Model }): ModelResolver {
  if (!opts.model) {
    throw new TypeError('weaveModelResolver: opts.model is required');
  }
  const pinned = opts.model;
  return {
    resolve: () => pinned,
  };
}

/**
 * Build a `ModelResolver` from a callback. Useful when you already have a
 * routing function (e.g. wrapping a `SmartModelRouter`) and want to lift
 * it into the resolver shape without writing a class.
 *
 * @example
 * ```ts
 * const resolver = weaveModelResolverFromFn(async (ctx) => {
 *   const routed = await router.pick(ctx.role, ctx.capability);
 *   return routed?.model;
 * });
 * ```
 */
export function weaveModelResolverFromFn(
  fn: (
    ctx: ModelResolverContext,
  ) => Promise<Model | undefined> | Model | undefined,
): ModelResolver {
  if (typeof fn !== 'function') {
    throw new TypeError('weaveModelResolverFromFn: fn must be a function');
  }
  return { resolve: (ctx) => fn(ctx) };
}

/**
 * Compose a chain of resolvers — try each in order, returning the first
 * non-`undefined` result. A throw from one resolver is logged (if `log`
 * is provided) and treated as `undefined`, so the chain continues.
 *
 * Useful for layering: `[per-agent overrides, mesh policy, tenant default]`.
 *
 * @example
 * ```ts
 * const resolver = composeModelResolvers([
 *   perAgentOverride,
 *   meshPolicyResolver,
 *   weaveModelResolver({ model: defaultModel }),
 * ]);
 * ```
 */
export function composeModelResolvers(
  resolvers: ReadonlyArray<ModelResolver>,
  opts?: { log?: (msg: string) => void },
): ModelResolver {
  if (!Array.isArray(resolvers) || resolvers.length === 0) {
    throw new TypeError(
      'composeModelResolvers: resolvers must be a non-empty array',
    );
  }
  const log = opts?.log;
  return {
    resolve: async (ctx) => {
      for (let i = 0; i < resolvers.length; i += 1) {
        const r = resolvers[i]!;
        try {
          const result = await r.resolve(ctx);
          if (result) return result;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log?.(`[composeModelResolvers] resolver[${i}] threw: ${msg}`);
        }
      }
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution helper used by `agentic-task-handler` and any future caller
// that needs the same fallback semantics.
// ---------------------------------------------------------------------------

/** Outcome of `resolveModelForTick`. The caller uses `model` directly and
 *  may inspect `source` / `error` for telemetry. */
export interface ResolvedModel {
  model: Model;
  /** Where the model came from — useful for log lines and audit events. */
  source: 'resolver' | 'pinned';
  /** Populated when the resolver was attempted but threw or returned
   *  `undefined` and we fell back to the pinned model. */
  error?: string;
}

/**
 * Single source of truth for the resolver→pinned fallback chain. Every
 * live-agents call site that needs a model for the next tick should go
 * through this helper so the semantics stay identical across handlers.
 *
 * Behavior:
 *   1. If `resolver` is provided, call `resolver.resolve(ctx)`.
 *      a. Returned `Model` → use it (`source: 'resolver'`).
 *      b. Returned `undefined` → fall through to step 2 (with no error).
 *      c. Threw → fall through to step 2 (capture `error`).
 *   2. If `pinned` is provided, use it (`source: 'pinned'`).
 *   3. Otherwise throw a clear error — no model to invoke.
 */
export async function resolveModelForTick(
  resolver: ModelResolver | undefined,
  pinned: Model | undefined,
  ctx: ModelResolverContext,
): Promise<ResolvedModel> {
  let resolverError: string | undefined;
  if (resolver) {
    try {
      const candidate = await resolver.resolve(ctx);
      if (candidate) return { model: candidate, source: 'resolver' };
    } catch (err) {
      resolverError = err instanceof Error ? err.message : String(err);
    }
  }
  if (pinned) {
    return resolverError
      ? { model: pinned, source: 'pinned', error: resolverError }
      : { model: pinned, source: 'pinned' };
  }
  throw new Error(
    'live-agents: no model available — provide either `model` (pinned) or `modelResolver` ' +
      'returning a Model. Both were absent or returned undefined.' +
      (resolverError ? ` Last resolver error: ${resolverError}` : ''),
  );
}
