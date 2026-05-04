/**
 * Phase 2 — `weaveAgentOverlayResolver`: per-agent DB-row overlay on top of
 * a base `ModelResolver`.
 *
 * Reads the three `model_*` columns from a `live_agents` (or
 * `live_agent_definitions`) row and overlays them on a base resolver:
 *
 *   - `model_pinned_id` set       → bypass routing entirely; load that
 *                                    pinned id via `loadPinnedModel(id)`.
 *   - `model_capability_json` set → call the base resolver with a
 *                                    `ctx.capability` overlay merged in
 *                                    (per-agent capability hint wins).
 *   - `model_routing_policy_key`  → forwarded to the base resolver via
 *                                    `ctx.capability.hints.policyKey` so
 *                                    capability-aware routers can honour it.
 *   - none of the above           → delegate to base resolver unchanged.
 *
 * Best-effort audit: when a `runId` is on the context (set by the runtime
 * at heartbeat time) and a `db.appendLiveRunEvent` writer is supplied, an
 * append-only `live_run_events` row of kind `model.resolved` is written so
 * replays can reproduce which model each tick used.
 *
 * --- Why a wrapper, not a replacement ---
 *
 * The base resolver (typically `weaveDbModelResolver`) handles platform-
 * wide routing — model_pricing rows, active routing_policies, candidate
 * filtering. The overlay only encodes per-agent intent ("this agent is
 * pinned to X for replay" or "this agent prefers high-context models").
 * Composing them keeps each layer single-purpose and testable.
 *
 * @example
 * ```ts
 * import {
 *   weaveDbModelResolver,
 *   weaveAgentOverlayResolver,
 * } from '@weaveintel/live-agents-runtime';
 *
 * const base = weaveDbModelResolver({ ... });
 * const overlay = weaveAgentOverlayResolver({
 *   base,
 *   getAgentRow: (agentId) => db.getLiveAgent(agentId),
 *   loadPinnedModel: (id) => myModelFactory.fromPinnedId(id),
 *   appendAuditEvent: (ev) => db.appendLiveRunEvent(ev),
 *   newId: () => crypto.randomUUID(),
 * });
 * ```
 */

import type { Model } from '@weaveintel/core';
import type { ModelResolver, ModelResolverContext } from '@weaveintel/live-agents';
import {
  resolveAgentModelSpec,
  type AgentModelFieldsRowLike,
  type ResolvedAgentModelSpec,
} from './model-resolver.js';

// ---------------------------------------------------------------------------
// Audit shape — kept narrow so apps don't have to expose a full DB adapter.
// ---------------------------------------------------------------------------

/**
 * Minimal subset of geneweave's `live_run_events` row the overlay writes.
 * Apps using a different schema can adapt in the `appendAuditEvent` callback.
 */
export interface ModelResolvedAuditEvent {
  id: string;
  run_id: string;
  step_id: string | null;
  kind: 'model.resolved';
  agent_id: string;
  tool_key: null;
  summary: string;
  payload_json: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WeaveAgentOverlayResolverOptions {
  /**
   * Base resolver delegated to when the agent row has no overlay (or only
   * a capability hint that should be merged with the base routing).
   */
  base: ModelResolver;
  /**
   * Fetch the agent row containing the `model_*` columns. Called fresh per
   * tick so DB updates take effect immediately. Return `null` to skip the
   * overlay and pass through to `base`.
   */
  getAgentRow: (
    agentId: string,
  ) => Promise<(AgentModelFieldsRowLike & { id: string }) | null>;
  /**
   * Build a `Model` directly from a pinned id. Required only if any agent
   * row is expected to set `model_pinned_id`. Throw → overlay falls back
   * to the base resolver.
   */
  loadPinnedModel?: (modelId: string) => Promise<Model>;
  /** Optional best-effort audit writer. Failures are swallowed. */
  appendAuditEvent?: (ev: ModelResolvedAuditEvent) => Promise<void>;
  /** UUID generator for audit event ids. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
  /** Optional logger. */
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

/**
 * Build a `ModelResolver` that overlays per-agent DB intent on top of a base
 * resolver. Safe to share across every agent in a mesh — per-agent state is
 * looked up fresh per call.
 */
export function weaveAgentOverlayResolver(
  opts: WeaveAgentOverlayResolverOptions,
): ModelResolver {
  const log = opts.log ?? (() => {});
  const newId = opts.newId ?? (() => cryptoRandomUUID());

  return {
    async resolve(ctx: ModelResolverContext): Promise<Model | undefined> {
      // No agent id → nothing to overlay; delegate.
      if (!ctx.agentId) return opts.base.resolve(ctx);

      let row: (AgentModelFieldsRowLike & { id: string }) | null;
      try {
        row = await opts.getAgentRow(ctx.agentId);
      } catch (err) {
        log(`weaveAgentOverlayResolver: getAgentRow(${ctx.agentId}) threw — using base. ${describeErr(err)}`);
        return opts.base.resolve(ctx);
      }
      if (!row) return opts.base.resolve(ctx);

      const spec = resolveAgentModelSpec(row);

      // Pinned id → load directly; never call the base resolver.
      if (spec.source === 'pinned' && spec.pinnedId) {
        if (!opts.loadPinnedModel) {
          log(
            `weaveAgentOverlayResolver: agent ${ctx.agentId} has model_pinned_id=${spec.pinnedId} ` +
              `but no loadPinnedModel supplied — falling back to base.`,
          );
          return opts.base.resolve(ctx);
        }
        try {
          const model = await opts.loadPinnedModel(spec.pinnedId);
          await maybeAudit(opts, ctx, spec, `pinned:${spec.pinnedId}`, newId);
          return model;
        } catch (err) {
          log(
            `weaveAgentOverlayResolver: loadPinnedModel(${spec.pinnedId}) threw — ` +
              `falling back to base. ${describeErr(err)}`,
          );
          return opts.base.resolve(ctx);
        }
      }

      // Capability hint → merge with ctx.capability and delegate.
      if (spec.source === 'capability' && spec.capabilitySpec) {
        const overlaidCtx: ModelResolverContext = {
          ...ctx,
          capability: {
            ...(ctx.capability ?? {}),
            ...(spec.capabilitySpec as ModelResolverContext['capability']),
            hints: {
              ...(ctx.capability?.hints ?? {}),
              ...((spec.capabilitySpec as { hints?: Record<string, unknown> }).hints ?? {}),
              ...(spec.routingPolicyKey ? { policyKey: spec.routingPolicyKey } : {}),
            },
          },
        };
        const model = await opts.base.resolve(overlaidCtx);
        if (model) {
          await maybeAudit(opts, ctx, spec, `routed:${describeCapability(spec.capabilitySpec)}`, newId);
        }
        return model;
      }

      // Default — delegate untouched.
      const model = await opts.base.resolve(ctx);
      if (model) {
        await maybeAudit(opts, ctx, spec, 'default', newId);
      }
      return model;
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function maybeAudit(
  opts: WeaveAgentOverlayResolverOptions,
  ctx: ModelResolverContext,
  spec: ResolvedAgentModelSpec,
  label: string,
  newId: () => string,
): Promise<void> {
  if (!opts.appendAuditEvent || !ctx.runId || !ctx.agentId) return;
  try {
    await opts.appendAuditEvent({
      id: newId(),
      run_id: ctx.runId,
      step_id: ctx.stepId != null ? String(ctx.stepId) : null,
      kind: 'model.resolved',
      agent_id: ctx.agentId,
      tool_key: null,
      summary: label,
      payload_json: JSON.stringify({
        source: spec.source,
        pinnedId: spec.pinnedId,
        routingPolicyKey: spec.routingPolicyKey,
        capabilitySpec: spec.capabilitySpec,
      }),
    });
  } catch {
    /* audit is best-effort */
  }
}

function describeCapability(spec: Record<string, unknown>): string {
  const task = typeof spec['task'] === 'string' ? (spec['task'] as string) : 'generic';
  const tool = spec['toolUse'] === true ? '+tool' : '';
  return `${task}${tool}`;
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cryptoRandomUUID(): string {
  // Node 14+ exposes crypto.randomUUID via globalThis.crypto.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback: cheap timestamp+random. Audit ids don't need to be cryptographic.
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
