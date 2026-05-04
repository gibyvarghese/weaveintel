/**
 * Phase 6 — `weaveLiveMeshFromDb`: one-call mesh hydration.
 *
 * This is the **canonical user-facing entry point** for booting a
 * DB-driven live-agents mesh. It composes every Phase 1-5 primitive
 * (provisioner + handler registry + model resolver + attention policy +
 * heartbeat supervisor + run-state bridge) into a single call so apps
 * never have to hand-wire boot code again.
 *
 * --- Two operating modes ---
 *
 *   A) **Provision then boot** — pass `meshDefId` or `meshDefKey`. The
 *      function calls `provisionMesh()` to materialise a fresh runtime
 *      mesh from the DB blueprint, then starts the supervisor.
 *
 *   B) **Boot existing meshes** — pass nothing (or `meshId` for log
 *      clarity). The supervisor starts and ticks every active mesh in
 *      the DB. This is the common case for long-running services that
 *      want operators to manage meshes via the admin UI.
 *
 * --- What it composes (in order) ---
 *
 *   1. `provisionMesh(db, opts.provision)` — only when a blueprint is
 *      supplied. Returns the new mesh id + agent ids.
 *   2. `createDefaultHandlerRegistry()` — the four built-in handler
 *      kinds (`agentic.react`, `deterministic.forward`,
 *      `deterministic.template`, `human.approval`) plus any caller
 *      `extraHandlerKinds`.
 *   3. `weaveDbModelResolver` — already constructed by the caller and
 *      passed in via `opts.modelResolver`. (We do not synthesise one
 *      here because the resolver needs app-specific routing brain +
 *      provider config that belongs in the consuming app.)
 *   4. `resolveAttentionPolicyFromDb(db, key)` — invoked by the
 *      supervisor when `attentionPolicyKey` is set.
 *   5. `createHeartbeatSupervisor(...)` — wires the registry,
 *      resolver, policy, attention policy, and per-tick context
 *      extras into the tick loop. Internally calls `bridgeRunState`
 *      every tick to mirror StateStore agent state into
 *      `live_run_steps` + `live_run_events`.
 *
 * --- Adoption guidance ---
 *
 * New apps should boot with this function and only inject:
 *   - The shared StateStore (in-memory for tests, sqlite/postgres for
 *     prod).
 *   - The `ModelResolver` (typically `weaveDbModelResolver` wrapping
 *     the app's model-routing brain).
 *   - The optional `LiveAgentPolicy` (build with
 *     `weaveDbLiveAgentPolicy` for DB-backed enforcement).
 *   - Any `extraHandlerKinds` the app defines beyond the built-ins.
 *   - A `tenantId` + `ownerHumanId` if the function is also
 *     provisioning.
 *
 * Existing geneweave code should migrate from
 * `createHeartbeatSupervisor()` directly to this function as a single
 * call — see `apps/geneweave/src/live-agents/generic-supervisor-boot.ts`
 * for the canonical pattern.
 */

import type { Model } from '@weaveintel/core';
import type { StateStore } from '@weaveintel/live-agents';
import type { LiveAgentPolicy, ModelResolver } from '@weaveintel/live-agents';

import {
  createHeartbeatSupervisor,
  type HeartbeatSupervisorHandle,
  type HeartbeatSupervisorOptions,
} from './heartbeat-supervisor.js';
import {
  HandlerRegistry,
  type HandlerKindRegistration,
} from './handler-registry.js';
import { createDefaultHandlerRegistry } from './index.js';
import {
  provisionMesh,
  type ProvisionAccountSpec,
  type ProvisionMeshResult,
} from './mesh-provisioner.js';
import type { LiveAgentsDb } from './db-types.js';

// ─── Public option / result shapes ───────────────────────────

/** Optional provisioning step. When supplied, a fresh mesh is created
 *  before the supervisor starts. */
export interface WeaveLiveMeshProvisionOptions {
  /** Either `meshDefId` or `meshDefKey` is required. */
  meshDefId?: string;
  meshDefKey?: string;
  tenantId: string | null;
  ownerHumanId: string;
  /** Optional override for the runtime mesh name. */
  name?: string;
  /** Initial status (default 'ACTIVE'). */
  status?: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  /** Optional account spec for MCP-backed agents. */
  account?: ProvisionAccountSpec;
}

export interface WeaveLiveMeshFromDbOptions {
  /** Shared StateStore the supervisor + provisioner will both write to. */
  store: StateStore;

  /** Provision a new mesh from a DB blueprint before booting. Omit to
   *  boot whatever's already ACTIVE in the DB. */
  provision?: WeaveLiveMeshProvisionOptions;

  // ── Capability slots (mirror weaveLiveAgent / weaveAgent) ──
  /** Per-tick model resolver. Build via `weaveDbModelResolver` in apps
   *  with a routing brain. Not required if every handler binding is
   *  deterministic (no LLM calls). */
  modelResolver?: ModelResolver;
  /** Pinned model fallback. Returns `undefined` to put handlers in
   *  deterministic-only mode. */
  modelFactory?: () => Promise<Model | undefined>;
  /** First-class policy bundle. Build via `weaveLiveAgentPolicy(...)`
   *  in tests or `weaveDbLiveAgentPolicy(...)` for DB-backed
   *  enforcement. */
  policy?: LiveAgentPolicy;

  // ── Handler kinds ──
  /** Extra handler kinds beyond the four built-ins. */
  extraHandlerKinds?: HandlerKindRegistration[];
  /** Pre-built registry. When supplied, `extraHandlerKinds` is
   *  ignored and the caller-supplied registry is used as-is. */
  handlerRegistry?: HandlerRegistry;

  // ── Supervisor knobs (forwarded as-is) ──
  /** DB-backed prompt resolver. Forwarded to handlers via context. */
  resolveSystemPrompt?: HeartbeatSupervisorOptions['resolveSystemPrompt'];
  /** Default attention policy DB key. */
  attentionPolicyKey?: string;
  /** Optional hook for per-binding context fields (e.g. `approvalDb`,
   *  `resolveAgentByRole`). */
  extraContextFor?: HeartbeatSupervisorOptions['extraContextFor'];

  /** Number of parallel heartbeat workers. Default 4. */
  workers?: number;
  /** Schedule + bridge interval ms. Default 5000. */
  intervalMs?: number;
  /** Active-role refresh interval ms. Default 30000. */
  refreshMs?: number;
  /** Worker id prefix. */
  workerIdPrefix?: string;

  /** Logger. */
  logger?: (msg: string) => void;
}

export interface WeaveLiveMeshFromDbResult {
  /** Provision result, or `null` when the function only booted existing
   *  meshes. */
  provisioned: ProvisionMeshResult | null;
  /** The handler registry the supervisor was built with. Apps can inspect
   *  it to verify all expected kinds are registered. */
  handlerRegistry: HandlerRegistry;
  /** Live supervisor handle. Apps rarely need this directly — prefer
   *  `stop()` on the result. */
  supervisor: HeartbeatSupervisorHandle;
  /** Single shutdown function. Idempotent. */
  stop: () => Promise<void>;
}

// ─── Implementation ─────────────────────────────────────────

/**
 * One-call hydration of a live-agents mesh from the DB.
 *
 * @example Provision a new mesh and start ticking:
 * ```ts
 * const handle = await weaveLiveMeshFromDb(db, {
 *   store,
 *   modelResolver: weaveDbModelResolver({ ... }),
 *   provision: {
 *     meshDefKey: 'kaggle.classic',
 *     tenantId: 'acme',
 *     ownerHumanId: 'human:operator',
 *   },
 *   extraHandlerKinds: kaggleHandlerKinds,
 * });
 * // ... later
 * await handle.stop();
 * ```
 *
 * @example Boot existing meshes only:
 * ```ts
 * const handle = await weaveLiveMeshFromDb(db, {
 *   store,
 *   modelResolver,
 * });
 * ```
 */
export async function weaveLiveMeshFromDb(
  db: LiveAgentsDb,
  opts: WeaveLiveMeshFromDbOptions,
): Promise<WeaveLiveMeshFromDbResult> {
  const log =
    opts.logger ?? ((m: string) => console.log('[live-mesh-from-db]', m));

  // 1. Provision a new mesh if requested.
  let provisioned: ProvisionMeshResult | null = null;
  if (opts.provision) {
    if (!opts.provision.meshDefId && !opts.provision.meshDefKey) {
      throw new Error(
        'weaveLiveMeshFromDb: provision.meshDefId or provision.meshDefKey is required',
      );
    }
    provisioned = await provisionMesh(db, {
      ...(opts.provision.meshDefId ? { meshDefId: opts.provision.meshDefId } : {}),
      ...(opts.provision.meshDefKey ? { meshDefKey: opts.provision.meshDefKey } : {}),
      tenantId: opts.provision.tenantId,
      ownerHumanId: opts.provision.ownerHumanId,
      ...(opts.provision.name ? { name: opts.provision.name } : {}),
      ...(opts.provision.status ? { status: opts.provision.status } : {}),
      ...(opts.provision.account ? { account: opts.provision.account } : {}),
      store: opts.store,
      logger: (m) => log(`[provision] ${m}`),
    });
    log(
      `provisioned mesh=${provisioned.meshId} agents=${provisioned.agentIds.length}`,
    );
  }

  // 2. Resolve handler registry. Caller-supplied wins; otherwise build
  //    default + extras. Mutating the default registry is safe — apps
  //    register their kinds once and reuse the same instance forever.
  const registry = opts.handlerRegistry ?? createDefaultHandlerRegistry();
  if (!opts.handlerRegistry && opts.extraHandlerKinds) {
    for (const reg of opts.extraHandlerKinds) {
      registry.register(reg);
    }
  }

  // 3. Boot the supervisor. Conditional spreads preserve
  //    exactOptionalPropertyTypes compatibility — `undefined` is never
  //    assigned to an optional field.
  const supervisor = await createHeartbeatSupervisor({
    db,
    store: opts.store,
    handlerRegistry: registry,
    ...(opts.modelResolver ? { modelResolver: opts.modelResolver } : {}),
    ...(opts.modelFactory ? { modelFactory: opts.modelFactory } : {}),
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.resolveSystemPrompt
      ? { resolveSystemPrompt: opts.resolveSystemPrompt }
      : {}),
    ...(opts.attentionPolicyKey
      ? { attentionPolicyKey: opts.attentionPolicyKey }
      : {}),
    ...(opts.extraContextFor ? { extraContextFor: opts.extraContextFor } : {}),
    ...(opts.workers !== undefined ? { workers: opts.workers } : {}),
    ...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
    ...(opts.refreshMs !== undefined ? { refreshMs: opts.refreshMs } : {}),
    ...(opts.workerIdPrefix ? { workerIdPrefix: opts.workerIdPrefix } : {}),
    logger: (m: string) => log(`[supervisor] ${m}`),
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await supervisor.stop();
    log('stopped');
  };

  log(
    `ready (provisioned=${provisioned ? 'yes' : 'no'} kinds=${registry.list().length})`,
  );

  return {
    provisioned,
    handlerRegistry: registry,
    supervisor,
    stop,
  };
}
