import { Pool, type PoolClient } from 'pg';
import type {
  Account,
  AccountBinding,
  AccountBindingRequest,
  BacklogItem,
  BreakGlassInvocation,
  CapabilityGrant,
  CrossMeshBridge,
  DelegationEdge,
  EventRoute,
  ExternalEvent,
  GrantRequest,
  HeartbeatTick,
  LiveAgent,
  Message,
  Mesh,
  OutboundActionRecord,
  PostgresStateStore,
  Promotion,
  PromotionRequest,
  StateStore,
  Team,
  TeamMembership,
  AgentContract,
} from './types.js';
import { weaveInMemoryStateStore } from './state-store.js';

interface Row {
  id: string;
  payload_json: string;
}

type PersistedEntityType =
  | 'mesh'
  | 'agent'
  | 'delegation_edge'
  | 'team'
  | 'team_membership'
  | 'cross_mesh_bridge'
  | 'contract'
  | 'account'
  | 'account_binding'
  | 'account_binding_request'
  | 'heartbeat_tick'
  | 'message'
  | 'backlog_item'
  | 'external_event'
  | 'event_route'
  | 'outbound_action_record'
  | 'capability_grant'
  | 'grant_request'
  | 'break_glass_invocation'
  | 'promotion_request'
  | 'promotion';

type PersistableEntity =
  | Mesh
  | LiveAgent
  | DelegationEdge
  | Team
  | TeamMembership
  | CrossMeshBridge
  | AgentContract
  | Account
  | AccountBinding
  | AccountBindingRequest
  | HeartbeatTick
  | Message
  | BacklogItem
  | ExternalEvent
  | EventRoute
  | OutboundActionRecord
  | CapabilityGrant
  | GrantRequest
  | BreakGlassInvocation
  | PromotionRequest
  | Promotion;

interface PersistedRecord {
  entityType: PersistedEntityType;
  id: string;
  payload: PersistableEntity;
}

const MIGRATIONS_SQL = `
-- Canonical entity store for Phase 1.
-- We persist each live-agents domain object as JSONB and rely on
-- (entity_type, id) upsert semantics for idempotent mutation writes.
CREATE TABLE IF NOT EXISTS la_entities (
  entity_type TEXT NOT NULL,
  id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_type, id)
);

CREATE INDEX IF NOT EXISTS idx_la_entities_type_updated
  ON la_entities(entity_type, updated_at);
`;

const ENTITY_TYPE_BY_SAVE_METHOD: Record<string, PersistedEntityType> = {
  // Direct "save*" methods carry the canonical entity payload in arg[0].
  saveMesh: 'mesh',
  saveAgent: 'agent',
  saveDelegationEdge: 'delegation_edge',
  saveTeam: 'team',
  saveTeamMembership: 'team_membership',
  saveCrossMeshBridge: 'cross_mesh_bridge',
  saveContract: 'contract',
  saveAccount: 'account',
  saveAccountBinding: 'account_binding',
  saveAccountBindingRequest: 'account_binding_request',
  saveHeartbeatTick: 'heartbeat_tick',
  saveMessage: 'message',
  saveBacklogItem: 'backlog_item',
  saveExternalEvent: 'external_event',
  saveEventRoute: 'event_route',
  saveOutboundActionRecord: 'outbound_action_record',
  saveCapabilityGrant: 'capability_grant',
  saveGrantRequest: 'grant_request',
  saveBreakGlassInvocation: 'break_glass_invocation',
  savePromotionRequest: 'promotion_request',
  savePromotion: 'promotion',
};

const ENTITY_TYPE_BY_RETURNING_MUTATOR: Record<string, PersistedEntityType> = {
  // Transition/revoke/resolve methods return the updated entity; we persist that value.
  transitionAgentStatus: 'agent',
  revokeCrossMeshBridge: 'cross_mesh_bridge',
  transitionAccountStatus: 'account',
  revokeAccountBinding: 'account_binding',
  resolveAccountBindingRequest: 'account_binding_request',
  transitionMessageStatus: 'message',
  transitionBacklogItemStatus: 'backlog_item',
  revokeCapabilityGrant: 'capability_grant',
  resolveGrantRequest: 'grant_request',
  reviewBreakGlassInvocation: 'break_glass_invocation',
  resolvePromotionRequest: 'promotion_request',
};

const ARRAY_RETURNING_MUTATOR_ENTITY_TYPE: Record<string, PersistedEntityType> = {
  // claimNextTicks returns a leased set of tick rows that must be durably updated.
  claimNextTicks: 'heartbeat_tick',
};

// Hydration order matters because some save paths enforce cross-entity invariants.
const HYDRATION_ORDER: readonly PersistedEntityType[] = [
  'mesh',
  'agent',
  'delegation_edge',
  'team',
  'team_membership',
  'cross_mesh_bridge',
  'contract',
  'account',
  'account_binding',
  'account_binding_request',
  'capability_grant',
  'grant_request',
  'break_glass_invocation',
  'promotion_request',
  'promotion',
  'heartbeat_tick',
  'message',
  'backlog_item',
  'external_event',
  'event_route',
  'outbound_action_record',
];

async function upsertEntity(client: PoolClient, record: PersistedRecord): Promise<void> {
  // Upsert gives idempotent write behavior for repeated mutation calls.
  await client.query(
    `
    INSERT INTO la_entities (entity_type, id, payload_json, updated_at)
    VALUES ($1, $2, $3::jsonb, NOW())
    ON CONFLICT (entity_type, id)
    DO UPDATE SET payload_json = EXCLUDED.payload_json, updated_at = NOW()
    `,
    [record.entityType, record.id, JSON.stringify(record.payload)],
  );
}

async function loadEntities<T extends PersistableEntity>(
  client: PoolClient,
  entityType: PersistedEntityType,
): Promise<T[]> {
  const result = await client.query<Row>(
    `
    SELECT id, payload_json::text AS payload_json
    FROM la_entities
    WHERE entity_type = $1
    ORDER BY updated_at ASC
    `,
    [entityType],
  );
  return result.rows.map((row) => JSON.parse(row.payload_json) as T);
}

function asPersistedRecord(methodName: string, args: unknown[], result: unknown): PersistedRecord[] {
  // Strategy:
  // 1) save* path -> persist arg[0]
  // 2) mutator path -> persist returned object
  // 3) batch mutator path -> persist each returned object in array
  const directEntityType = ENTITY_TYPE_BY_SAVE_METHOD[methodName];
  if (directEntityType) {
    const payload = args[0] as PersistableEntity | undefined;
    if (!payload || typeof payload !== 'object' || !('id' in payload)) {
      return [];
    }
    return [{ entityType: directEntityType, id: String(payload.id), payload }];
  }

  const returningEntityType = ENTITY_TYPE_BY_RETURNING_MUTATOR[methodName];
  if (returningEntityType) {
    const payload = result as PersistableEntity | null;
    if (!payload || typeof payload !== 'object' || !('id' in payload)) {
      return [];
    }
    return [{ entityType: returningEntityType, id: String(payload.id), payload }];
  }

  const arrayEntityType = ARRAY_RETURNING_MUTATOR_ENTITY_TYPE[methodName];
  if (arrayEntityType) {
    const items = Array.isArray(result) ? (result as PersistableEntity[]) : [];
    return items
      .filter((item) => item && typeof item === 'object' && 'id' in item)
      .map((item) => ({
        entityType: arrayEntityType,
        id: String(item.id),
        payload: item,
      }));
  }

  return [];
}

async function hydrateInMemoryState(inMemory: StateStore, client: PoolClient): Promise<void> {
  // Hydration replays durable JSON rows back through the in-memory implementation.
  // This preserves all guardrail invariants already encoded in weaveInMemoryStateStore.
  for (const entityType of HYDRATION_ORDER) {
    switch (entityType) {
      case 'mesh': {
        const rows = await loadEntities<Mesh>(client, entityType);
        for (const row of rows) await inMemory.saveMesh(row);
        break;
      }
      case 'agent': {
        const rows = await loadEntities<LiveAgent>(client, entityType);
        for (const row of rows) await inMemory.saveAgent(row);
        break;
      }
      case 'delegation_edge': {
        const rows = await loadEntities<DelegationEdge>(client, entityType);
        for (const row of rows) await inMemory.saveDelegationEdge(row);
        break;
      }
      case 'team': {
        const rows = await loadEntities<Team>(client, entityType);
        for (const row of rows) await inMemory.saveTeam(row);
        break;
      }
      case 'team_membership': {
        const rows = await loadEntities<TeamMembership>(client, entityType);
        for (const row of rows) await inMemory.saveTeamMembership(row);
        break;
      }
      case 'cross_mesh_bridge': {
        const rows = await loadEntities<CrossMeshBridge>(client, entityType);
        for (const row of rows) await inMemory.saveCrossMeshBridge(row);
        break;
      }
      case 'contract': {
        const rows = await loadEntities<AgentContract>(client, entityType);
        for (const row of rows) await inMemory.saveContract(row);
        break;
      }
      case 'account': {
        const rows = await loadEntities<Account>(client, entityType);
        for (const row of rows) await inMemory.saveAccount(row);
        break;
      }
      case 'account_binding': {
        const rows = await loadEntities<AccountBinding>(client, entityType);
        for (const row of rows) await inMemory.saveAccountBinding(row);
        break;
      }
      case 'account_binding_request': {
        const rows = await loadEntities<AccountBindingRequest>(client, entityType);
        for (const row of rows) await inMemory.saveAccountBindingRequest(row);
        break;
      }
      case 'heartbeat_tick': {
        const rows = await loadEntities<HeartbeatTick>(client, entityType);
        for (const row of rows) await inMemory.saveHeartbeatTick(row);
        break;
      }
      case 'message': {
        const rows = await loadEntities<Message>(client, entityType);
        for (const row of rows) await inMemory.saveMessage(row);
        break;
      }
      case 'backlog_item': {
        const rows = await loadEntities<BacklogItem>(client, entityType);
        for (const row of rows) await inMemory.saveBacklogItem(row);
        break;
      }
      case 'external_event': {
        const rows = await loadEntities<ExternalEvent>(client, entityType);
        for (const row of rows) await inMemory.saveExternalEvent(row);
        break;
      }
      case 'event_route': {
        const rows = await loadEntities<EventRoute>(client, entityType);
        for (const row of rows) await inMemory.saveEventRoute(row);
        break;
      }
      case 'outbound_action_record': {
        const rows = await loadEntities<OutboundActionRecord>(client, entityType);
        for (const row of rows) await inMemory.saveOutboundActionRecord(row);
        break;
      }
      case 'capability_grant': {
        const rows = await loadEntities<CapabilityGrant>(client, entityType);
        for (const row of rows) await inMemory.saveCapabilityGrant(row);
        break;
      }
      case 'grant_request': {
        const rows = await loadEntities<GrantRequest>(client, entityType);
        for (const row of rows) await inMemory.saveGrantRequest(row);
        break;
      }
      case 'break_glass_invocation': {
        const rows = await loadEntities<BreakGlassInvocation>(client, entityType);
        for (const row of rows) await inMemory.saveBreakGlassInvocation(row);
        break;
      }
      case 'promotion_request': {
        const rows = await loadEntities<PromotionRequest>(client, entityType);
        for (const row of rows) await inMemory.savePromotionRequest(row);
        break;
      }
      case 'promotion': {
        const rows = await loadEntities<Promotion>(client, entityType);
        for (const row of rows) await inMemory.savePromotion(row);
        break;
      }
      default:
        break;
    }
  }
}

export async function weavePostgresStateStore(opts: { url: string }): Promise<PostgresStateStore> {
  const pool = new Pool({ connectionString: opts.url });
  const inMemory = weaveInMemoryStateStore();

  const initialize = async (): Promise<void> => {
    const client = await pool.connect();
    try {
      await client.query(MIGRATIONS_SQL);
      await hydrateInMemoryState(inMemory, client);
    } finally {
      client.release();
    }
  };

  const close = async (): Promise<void> => {
    await pool.end();
  };

  const store = new Proxy(inMemory as StateStore, {
    get(target, prop, receiver) {
      if (prop === '__kind') {
        return 'postgres';
      }
      if (prop === 'initialize') {
        return initialize;
      }
      if (prop === 'close') {
        return close;
      }

      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== 'function') {
        return original;
      }

      return async (...args: unknown[]) => {
        // Execute business logic first in the battle-tested in-memory implementation.
        // If that succeeds, persist the resulting entity mutation atomically.
        const result = await original.apply(target, args);
        const methodName = String(prop);
        const updates = asPersistedRecord(methodName, args, result);

        if (updates.length === 0) {
          return result;
        }

        const client = await pool.connect();
        try {
          // Group all record upserts from a single mutating call in one transaction
          // so restart semantics remain consistent with method-level atomic intent.
          await client.query('BEGIN');
          for (const update of updates) {
            await upsertEntity(client, update);
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }

        return result;
      };
    },
  }) as PostgresStateStore;

  await store.initialize();
  return store;
}
