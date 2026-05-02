/**
 * Per-Agent Model Resolver — Phase 3.5 bridge.
 *
 * Geneweave bridge that takes the pure `resolveAgentModelSpec()` output
 * from `@weaveintel/live-agents-runtime` and turns it into a concrete
 * `Model` instance that a `HandlerContext` can carry.
 *
 * Resolution order (matches the plan):
 *
 *   1. `model_pinned_id` set → call the supplied `loadPinnedModel(id)`
 *      factory and return the result. Routing is bypassed (this is the
 *      replay / reproducibility escape hatch).
 *   2. `model_capability_json` set → call `routeByCapability(spec, key)`
 *      which is expected to delegate to `@weaveintel/routing` (or
 *      whatever the host app uses for capability → model selection).
 *   3. Neither set → call `defaultModel()` for the platform default.
 *
 * Every successful resolution emits an append-only `live_run_events` row
 * (`kind = 'model.resolved'`) so replays can reproduce what model was
 * used for each tick. When `runId` is omitted (e.g. one-off provisioning
 * checks) the audit emit is skipped.
 *
 * The bridge owns a small per-process cache keyed by `agentId` + `runId`
 * so a single ReAct loop doesn't pay the resolution cost on every step.
 */

import {
  resolveAgentModelSpec,
  type AgentModelFieldsRowLike,
  type ResolvedAgentModelSpec,
} from '@weaveintel/live-agents-runtime';
import type { Model } from '@weaveintel/core';
import type { DatabaseAdapter } from '../db-types.js';
import { newUUIDv7 } from '../lib/uuid.js';

/**
 * Pluggable hooks the host app provides. Keeping the bridge agnostic about
 * routing means tests can inject deterministic fakes and a future host can
 * swap in a richer routing implementation without touching this file.
 */
export interface AgentModelFactory {
  /** Build a model directly from a pinned id (escape hatch). */
  loadPinnedModel(modelId: string): Promise<Model>;
  /**
   * Map a capability spec → Model. Implementations typically delegate to
   * `@weaveintel/routing`'s SmartModelRouter, but a simple env-var lookup
   * is fine for examples / tests.
   */
  routeByCapability(
    spec: Record<string, unknown>,
    routingPolicyKey: string | null,
  ): Promise<Model>;
  /** Platform default when nothing is configured. */
  defaultModel(): Promise<Model>;
}

export interface ResolveLiveAgentModelOptions {
  /**
   * Optional run id. When provided, a `live_run_events` row of kind
   * `model.resolved` is appended for audit / replay.
   */
  runId?: string;
  /** Optional step id to attribute the audit event to. */
  stepId?: string;
}

export interface ResolvedLiveAgentModel {
  model: Model;
  spec: ResolvedAgentModelSpec;
  /** Stable label that callers can log without leaking provider keys. */
  label: string;
}

/**
 * Process-wide cache. Cleared by `clearLiveAgentModelCache()` (used by
 * tests). Key shape: `${agentId}::${runId ?? 'no-run'}` so two parallel
 * runs of the same agent don't share a model instance.
 */
const _cache = new Map<string, Promise<ResolvedLiveAgentModel>>();

export function clearLiveAgentModelCache(): void {
  _cache.clear();
}

/**
 * Resolve the effective Model for a live agent row.
 *
 * NB: caching is keyed by (agentId, runId). Callers that want a fresh
 * resolution (e.g. mid-run model swap during a replay) must pass a
 * different `runId` or call `clearLiveAgentModelCache()` first.
 */
export async function resolveLiveAgentModel(
  db: DatabaseAdapter,
  agentRow: AgentModelFieldsRowLike & { id: string },
  factory: AgentModelFactory,
  opts: ResolveLiveAgentModelOptions = {},
): Promise<ResolvedLiveAgentModel> {
  const cacheKey = `${agentRow.id}::${opts.runId ?? 'no-run'}`;
  const cached = _cache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const spec = resolveAgentModelSpec(agentRow);

    let model: Model;
    let label: string;
    if (spec.source === 'pinned' && spec.pinnedId) {
      model = await factory.loadPinnedModel(spec.pinnedId);
      label = `pinned:${spec.pinnedId}`;
    } else if (spec.source === 'capability' && spec.capabilitySpec) {
      model = await factory.routeByCapability(spec.capabilitySpec, spec.routingPolicyKey);
      label = `routed:${describeCapability(spec.capabilitySpec)}`;
    } else {
      model = await factory.defaultModel();
      label = 'default';
    }

    // Best-effort audit. Never block resolution on event-log failures.
    if (opts.runId) {
      try {
        await db.appendLiveRunEvent({
          id: newUUIDv7(),
          run_id: opts.runId,
          step_id: opts.stepId ?? null,
          kind: 'model.resolved',
          agent_id: agentRow.id,
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
        // swallow — audit is best-effort
      }
    }

    return { model, spec, label };
  })();

  _cache.set(cacheKey, promise);
  return promise;
}

function describeCapability(spec: Record<string, unknown>): string {
  const task = typeof spec['task'] === 'string' ? (spec['task'] as string) : 'generic';
  const tool = spec['toolUse'] === true ? '+tool' : '';
  return `${task}${tool}`;
}
