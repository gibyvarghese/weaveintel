import Database from 'better-sqlite3';
import type {
  Account,
  AccountBinding,
  AccountBindingRequest,
  AgentContract,
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
  Promotion,
  PromotionRequest,
  SqliteStateStore,
  StateStore,
  Team,
  TeamMembership,
} from './types.js';
import { weaveInMemoryStateStore } from './state-store.js';

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

interface SqliteRow {
  id: string;
  payload_json: string;
}

const MIGRATIONS_SQL = `
-- Phase 3 single-node durable entity store.
-- SQLite is the local durable mode, so we keep the schema intentionally small:
-- one table of JSON payload snapshots keyed by (entity_type, id).
CREATE TABLE IF NOT EXISTS la_entities (
  entity_type TEXT NOT NULL,
  id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_type, id)
);

CREATE INDEX IF NOT EXISTS idx_la_entities_type_updated
  ON la_entities(entity_type, updated_at);
`;

const ENTITY_TYPE_BY_SAVE_METHOD: Record<string, PersistedEntityType> = {
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
  claimNextTicks: 'heartbeat_tick',
};

// Hydration order preserves invariant checks enforced by the in-memory store.
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

function upsertEntity(db: Database.Database, record: PersistedRecord): void {
  const statement = db.prepare(`
    INSERT INTO la_entities (entity_type, id, payload_json, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (entity_type, id)
    DO UPDATE SET payload_json = excluded.payload_json, updated_at = CURRENT_TIMESTAMP
  `);
  statement.run(record.entityType, record.id, JSON.stringify(record.payload));
}

function loadEntities<T extends PersistableEntity>(
  db: Database.Database,
  entityType: PersistedEntityType,
): T[] {
  const statement = db.prepare(`
    SELECT id, payload_json
    FROM la_entities
    WHERE entity_type = ?
    ORDER BY updated_at ASC
  `);
  const rows = statement.all(entityType) as SqliteRow[];
  return rows.map((row) => JSON.parse(row.payload_json) as T);
}

function asPersistedRecords(methodName: string, args: unknown[], result: unknown): PersistedRecord[] {
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
      .map((item) => ({ entityType: arrayEntityType, id: String(item.id), payload: item }));
  }

  return [];
}

async function hydrateInMemoryState(inMemory: StateStore, db: Database.Database): Promise<void> {
  for (const entityType of HYDRATION_ORDER) {
    switch (entityType) {
      case 'mesh': {
        const rows = loadEntities<Mesh>(db, entityType);
        for (const row of rows) await inMemory.saveMesh(row);
        break;
      }
      case 'agent': {
        const rows = loadEntities<LiveAgent>(db, entityType);
        for (const row of rows) await inMemory.saveAgent(row);
        break;
      }
      case 'delegation_edge': {
        const rows = loadEntities<DelegationEdge>(db, entityType);
        for (const row of rows) await inMemory.saveDelegationEdge(row);
        break;
      }
      case 'team': {
        const rows = loadEntities<Team>(db, entityType);
        for (const row of rows) await inMemory.saveTeam(row);
        break;
      }
      case 'team_membership': {
        const rows = loadEntities<TeamMembership>(db, entityType);
        for (const row of rows) await inMemory.saveTeamMembership(row);
        break;
      }
      case 'cross_mesh_bridge': {
        const rows = loadEntities<CrossMeshBridge>(db, entityType);
        for (const row of rows) await inMemory.saveCrossMeshBridge(row);
        break;
      }
      case 'contract': {
        const rows = loadEntities<AgentContract>(db, entityType);
        for (const row of rows) await inMemory.saveContract(row);
        break;
      }
      case 'account': {
        const rows = loadEntities<Account>(db, entityType);
        for (const row of rows) await inMemory.saveAccount(row);
        break;
      }
      case 'account_binding': {
        const rows = loadEntities<AccountBinding>(db, entityType);
        for (const row of rows) await inMemory.saveAccountBinding(row);
        break;
      }
      case 'account_binding_request': {
        const rows = loadEntities<AccountBindingRequest>(db, entityType);
        for (const row of rows) await inMemory.saveAccountBindingRequest(row);
        break;
      }
      case 'heartbeat_tick': {
        const rows = loadEntities<HeartbeatTick>(db, entityType);
        for (const row of rows) await inMemory.saveHeartbeatTick(row);
        break;
      }
      case 'message': {
        const rows = loadEntities<Message>(db, entityType);
        for (const row of rows) await inMemory.saveMessage(row);
        break;
      }
      case 'backlog_item': {
        const rows = loadEntities<BacklogItem>(db, entityType);
        for (const row of rows) await inMemory.saveBacklogItem(row);
        break;
      }
      case 'external_event': {
        const rows = loadEntities<ExternalEvent>(db, entityType);
        for (const row of rows) await inMemory.saveExternalEvent(row);
        break;
      }
      case 'event_route': {
        const rows = loadEntities<EventRoute>(db, entityType);
        for (const row of rows) await inMemory.saveEventRoute(row);
        break;
      }
      case 'outbound_action_record': {
        const rows = loadEntities<OutboundActionRecord>(db, entityType);
        for (const row of rows) await inMemory.saveOutboundActionRecord(row);
        break;
      }
      case 'capability_grant': {
        const rows = loadEntities<CapabilityGrant>(db, entityType);
        for (const row of rows) await inMemory.saveCapabilityGrant(row);
        break;
      }
      case 'grant_request': {
        const rows = loadEntities<GrantRequest>(db, entityType);
        for (const row of rows) await inMemory.saveGrantRequest(row);
        break;
      }
      case 'break_glass_invocation': {
        const rows = loadEntities<BreakGlassInvocation>(db, entityType);
        for (const row of rows) await inMemory.saveBreakGlassInvocation(row);
        break;
      }
      case 'promotion_request': {
        const rows = loadEntities<PromotionRequest>(db, entityType);
        for (const row of rows) await inMemory.savePromotionRequest(row);
        break;
      }
      case 'promotion': {
        const rows = loadEntities<Promotion>(db, entityType);
        for (const row of rows) await inMemory.savePromotion(row);
        break;
      }
      default:
        break;
    }
  }
}

export async function weaveSqliteStateStore(opts: { path: string }): Promise<SqliteStateStore> {
  // SQLite is Phase 3 local durable mode. WAL improves single-node crash recovery
  // and lets reads coexist more smoothly with writes on the same file.
  const db = new Database(opts.path);
  const inMemory = weaveInMemoryStateStore();

  const initialize = async (): Promise<void> => {
    db.pragma('journal_mode = WAL');
    db.exec(MIGRATIONS_SQL);
    await hydrateInMemoryState(inMemory, db);
  };

  const close = async (): Promise<void> => {
    db.close();
  };

  const persistInTransaction = db.transaction((records: PersistedRecord[]) => {
    for (const record of records) {
      upsertEntity(db, record);
    }
  });

  const store = new Proxy(inMemory as StateStore, {
    get(target, prop, receiver) {
      if (prop === '__kind') {
        return 'sqlite';
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
        // As with Postgres, we let the in-memory implementation enforce business
        // rules first, then durably snapshot the resulting state mutation.
        const result = await original.apply(target, args);
        const records = asPersistedRecords(String(prop), args, result);
        if (records.length > 0) {
          persistInTransaction(records);
        }
        return result;
      };
    },
  }) as SqliteStateStore;

  await store.initialize();
  return store;
}
