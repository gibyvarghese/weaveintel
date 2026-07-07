// SPDX-License-Identifier: MIT
/**
 * The live-agents StateStore, implemented ONCE against Drizzle and reused for both Postgres and SQLite
 * (Phase 4). The store's design is unchanged: a battle-tested in-memory store enforces every business
 * rule, and after each successful mutation the affected entity is snapshotted as JSON into one
 * `la_entities` table. On start-up, `initialize()` replays those snapshots back through the in-memory
 * store (in a fixed order so cross-entity invariants hold).
 *
 * Before Phase 4 that whole ~300-line machine — the entity maps, the persist/hydrate dispatch, and the
 * Proxy — was copy-pasted into the Postgres and SQLite adapters, differing only in two tiny SQL queries.
 * Now it lives here once; the two queries are Drizzle (no raw SQL, no `$1`-vs-`?`, no hand-rolled JSON),
 * and the sync-vs-async difference between the drivers is hidden behind the `exec` seam. The 21-case
 * hydration switch collapses to a single data-driven loop.
 */
import { asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
  Account, AccountBinding, AccountBindingRequest, AgentContract, BacklogItem, BreakGlassInvocation,
  CapabilityGrant, CrossMeshBridge, DelegationEdge, EventRoute, ExternalEvent, GrantRequest,
  HeartbeatTick, LiveAgent, Message, Mesh, OutboundActionRecord, Promotion, PromotionRequest,
  StateStore, Team, TeamMembership,
} from './types.js';
import { weaveInMemoryStateStore } from './state-store.js';
import type { DrizzleExec } from './drizzle-support.js';
import { monotonicIso } from './drizzle-support.js';
import type { PgLaEntities } from './drizzle-state-schema.js';

type PersistedEntityType =
  | 'mesh' | 'agent' | 'delegation_edge' | 'team' | 'team_membership' | 'cross_mesh_bridge' | 'contract'
  | 'account' | 'account_binding' | 'account_binding_request' | 'heartbeat_tick' | 'message'
  | 'backlog_item' | 'external_event' | 'event_route' | 'outbound_action_record' | 'capability_grant'
  | 'grant_request' | 'break_glass_invocation' | 'promotion_request' | 'promotion';

type PersistableEntity =
  | Mesh | LiveAgent | DelegationEdge | Team | TeamMembership | CrossMeshBridge | AgentContract | Account
  | AccountBinding | AccountBindingRequest | HeartbeatTick | Message | BacklogItem | ExternalEvent
  | EventRoute | OutboundActionRecord | CapabilityGrant | GrantRequest | BreakGlassInvocation
  | PromotionRequest | Promotion;

interface PersistedRecord {
  entityType: PersistedEntityType;
  id: string;
  payload: PersistableEntity;
}

/** save*() method → the entity type it persists (arg[0] is the entity). */
const ENTITY_TYPE_BY_SAVE_METHOD: Record<string, PersistedEntityType> = {
  saveMesh: 'mesh', saveAgent: 'agent', saveDelegationEdge: 'delegation_edge', saveTeam: 'team',
  saveTeamMembership: 'team_membership', saveCrossMeshBridge: 'cross_mesh_bridge', saveContract: 'contract',
  saveAccount: 'account', saveAccountBinding: 'account_binding', saveAccountBindingRequest: 'account_binding_request',
  saveHeartbeatTick: 'heartbeat_tick', saveMessage: 'message', saveBacklogItem: 'backlog_item',
  saveExternalEvent: 'external_event', saveEventRoute: 'event_route', saveOutboundActionRecord: 'outbound_action_record',
  saveCapabilityGrant: 'capability_grant', saveGrantRequest: 'grant_request', saveBreakGlassInvocation: 'break_glass_invocation',
  savePromotionRequest: 'promotion_request', savePromotion: 'promotion',
};

/** transition/revoke/resolve/review method → the entity type it returns (the mutated entity is the result). */
const ENTITY_TYPE_BY_RETURNING_MUTATOR: Record<string, PersistedEntityType> = {
  transitionAgentStatus: 'agent', revokeCrossMeshBridge: 'cross_mesh_bridge', transitionAccountStatus: 'account',
  revokeAccountBinding: 'account_binding', resolveAccountBindingRequest: 'account_binding_request',
  transitionMessageStatus: 'message', transitionBacklogItemStatus: 'backlog_item', revokeCapabilityGrant: 'capability_grant',
  resolveGrantRequest: 'grant_request', reviewBreakGlassInvocation: 'break_glass_invocation', resolvePromotionRequest: 'promotion_request',
};

/** methods that return an array of mutated entities to persist. */
const ARRAY_RETURNING_MUTATOR_ENTITY_TYPE: Record<string, PersistedEntityType> = {
  claimNextTicks: 'heartbeat_tick',
};

/** Hydration order preserves the invariant checks the in-memory store enforces (parents before children). */
const HYDRATION_ORDER: readonly PersistedEntityType[] = [
  'mesh', 'agent', 'delegation_edge', 'team', 'team_membership', 'cross_mesh_bridge', 'contract',
  'account', 'account_binding', 'account_binding_request', 'capability_grant', 'grant_request',
  'break_glass_invocation', 'promotion_request', 'promotion', 'heartbeat_tick', 'message', 'backlog_item',
  'external_event', 'event_route', 'outbound_action_record',
];

/** entity type → the in-memory save method to replay it through (inverse of ENTITY_TYPE_BY_SAVE_METHOD). */
const SAVE_METHOD_BY_TYPE = Object.fromEntries(
  Object.entries(ENTITY_TYPE_BY_SAVE_METHOD).map(([method, type]) => [type, method]),
) as Record<PersistedEntityType, string>;

/** Work out which entity snapshots a just-completed mutation should persist. */
function asPersistedRecords(methodName: string, args: unknown[], result: unknown): PersistedRecord[] {
  const direct = ENTITY_TYPE_BY_SAVE_METHOD[methodName];
  if (direct) {
    const payload = args[0] as PersistableEntity | undefined;
    if (!payload || typeof payload !== 'object' || !('id' in payload)) return [];
    return [{ entityType: direct, id: String(payload.id), payload }];
  }
  const returning = ENTITY_TYPE_BY_RETURNING_MUTATOR[methodName];
  if (returning) {
    const payload = result as PersistableEntity | null;
    if (!payload || typeof payload !== 'object' || !('id' in payload)) return [];
    return [{ entityType: returning, id: String(payload.id), payload }];
  }
  const arrayType = ARRAY_RETURNING_MUTATOR_ENTITY_TYPE[methodName];
  if (arrayType) {
    const items = Array.isArray(result) ? (result as PersistableEntity[]) : [];
    return items
      .filter((item) => item && typeof item === 'object' && 'id' in item)
      .map((item) => ({ entityType: arrayType, id: String(item.id), payload: item }));
  }
  return [];
}

export interface DrizzleStateStoreDeps {
  /** The `__kind` value the store reports (`'postgres'` or `'sqlite'`). */
  kind: string;
  /** A Drizzle database handle (typed as the Postgres one; a SQLite handle is passed with a cast). */
  db: NodePgDatabase;
  /** The dialect's `la_entities` table. */
  table: PgLaEntities;
  /** The driver's sync/async execution adapter. */
  exec: DrizzleExec;
  /** Close the underlying handle (end the pool if owned, or close the SQLite database). */
  close: () => Promise<void>;
  now?: () => string;
}

/**
 * Build the shared Drizzle-backed StateStore. Both `weavePostgresStateStore` and `weaveSqliteStateStore`
 * are thin wrappers around this (they just create the `la_entities` table, then call `initialize()`).
 */
export function createDrizzleStateStore<S extends StateStore>(deps: DrizzleStateStoreDeps): S {
  const { kind, db, table, exec, close } = deps;
  const now = deps.now ?? monotonicIso();
  const inMemory = weaveInMemoryStateStore();

  const loadAll = async (entityType: PersistedEntityType): Promise<PersistableEntity[]> => {
    const rows = await exec.all<{ payloadJson: PersistableEntity }>(
      db.select({ payloadJson: table.payloadJson }).from(table).where(eq(table.entityType, entityType)).orderBy(asc(table.updatedAt)),
    );
    return rows.map((r) => r.payloadJson);
  };

  const persist = async (records: PersistedRecord[]): Promise<void> => {
    for (const r of records) {
      const ts = now();
      const payload = r.payload as unknown as Record<string, unknown>;
      await exec.run(
        db.insert(table).values({ entityType: r.entityType, id: r.id, payloadJson: payload, updatedAt: ts })
          .onConflictDoUpdate({ target: [table.entityType, table.id], set: { payloadJson: payload, updatedAt: ts } }),
      );
    }
  };

  // Replay every snapshot back through the in-memory store, parents before children.
  const initialize = async (): Promise<void> => {
    const anyStore = inMemory as unknown as Record<string, (entity: unknown) => Promise<unknown>>;
    for (const entityType of HYDRATION_ORDER) {
      const rows = await loadAll(entityType);
      const method = SAVE_METHOD_BY_TYPE[entityType];
      for (const row of rows) await anyStore[method]!(row);
    }
  };

  return new Proxy(inMemory as StateStore, {
    get(target, prop, receiver) {
      if (prop === '__kind') return kind;
      if (prop === 'initialize') return initialize;
      if (prop === 'close') return close;
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== 'function') return original;
      return async (...args: unknown[]) => {
        // Let the in-memory store enforce the business rules first, then durably snapshot the result.
        const result = await original.apply(target, args);
        const records = asPersistedRecords(String(prop), args, result);
        if (records.length > 0) await persist(records);
        return result;
      };
    },
  }) as unknown as S;
}
