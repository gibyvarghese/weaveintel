import {
  MongoClient,
  type Collection,
  type Db,
  type Document,
  type WithId,
} from 'mongodb';
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
  MongoDbStateStore,
  OutboundActionRecord,
  Promotion,
  PromotionRequest,
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

interface PersistedDocument extends Document {
  _id: string;
  entityType: PersistedEntityType;
  entityId: string;
  payload: PersistableEntity;
  updatedAt: Date;
}

export interface MongoDbStateStoreOptions {
  url: string;
  databaseName?: string;
  collectionName?: string;
}

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

// Hydration order mirrors the previous durable adapters so cross-entity invariants
// continue to be enforced by the in-memory implementation during replay.
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

function toDocumentId(entityType: PersistedEntityType, id: string): string {
  return `${entityType}:${id}`;
}

async function ensureIndexes(collection: Collection<PersistedDocument>): Promise<void> {
  await collection.createIndex({ entityType: 1, updatedAt: 1 }, { name: 'idx_entity_type_updated' });
  await collection.createIndex({ entityType: 1, entityId: 1 }, { name: 'idx_entity_type_id', unique: true });
}

async function upsertEntity(
  collection: Collection<PersistedDocument>,
  record: PersistedRecord,
): Promise<void> {
  await collection.updateOne(
    { _id: toDocumentId(record.entityType, record.id) },
    {
      $set: {
        entityType: record.entityType,
        entityId: record.id,
        payload: record.payload,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

async function loadEntities<T extends PersistableEntity>(
  collection: Collection<PersistedDocument>,
  entityType: PersistedEntityType,
): Promise<T[]> {
  const rows = await collection
    .find({ entityType })
    .sort({ updatedAt: 1 })
    .toArray();

  return rows.map((row) => row.payload as T);
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

async function hydrateInMemoryState(
  inMemory: StateStore,
  collection: Collection<PersistedDocument>,
): Promise<void> {
  for (const entityType of HYDRATION_ORDER) {
    switch (entityType) {
      case 'mesh': {
        const rows = await loadEntities<Mesh>(collection, entityType);
        for (const row of rows) await inMemory.saveMesh(row);
        break;
      }
      case 'agent': {
        const rows = await loadEntities<LiveAgent>(collection, entityType);
        for (const row of rows) await inMemory.saveAgent(row);
        break;
      }
      case 'delegation_edge': {
        const rows = await loadEntities<DelegationEdge>(collection, entityType);
        for (const row of rows) await inMemory.saveDelegationEdge(row);
        break;
      }
      case 'team': {
        const rows = await loadEntities<Team>(collection, entityType);
        for (const row of rows) await inMemory.saveTeam(row);
        break;
      }
      case 'team_membership': {
        const rows = await loadEntities<TeamMembership>(collection, entityType);
        for (const row of rows) await inMemory.saveTeamMembership(row);
        break;
      }
      case 'cross_mesh_bridge': {
        const rows = await loadEntities<CrossMeshBridge>(collection, entityType);
        for (const row of rows) await inMemory.saveCrossMeshBridge(row);
        break;
      }
      case 'contract': {
        const rows = await loadEntities<AgentContract>(collection, entityType);
        for (const row of rows) await inMemory.saveContract(row);
        break;
      }
      case 'account': {
        const rows = await loadEntities<Account>(collection, entityType);
        for (const row of rows) await inMemory.saveAccount(row);
        break;
      }
      case 'account_binding': {
        const rows = await loadEntities<AccountBinding>(collection, entityType);
        for (const row of rows) await inMemory.saveAccountBinding(row);
        break;
      }
      case 'account_binding_request': {
        const rows = await loadEntities<AccountBindingRequest>(collection, entityType);
        for (const row of rows) await inMemory.saveAccountBindingRequest(row);
        break;
      }
      case 'heartbeat_tick': {
        const rows = await loadEntities<HeartbeatTick>(collection, entityType);
        for (const row of rows) await inMemory.saveHeartbeatTick(row);
        break;
      }
      case 'message': {
        const rows = await loadEntities<Message>(collection, entityType);
        for (const row of rows) await inMemory.saveMessage(row);
        break;
      }
      case 'backlog_item': {
        const rows = await loadEntities<BacklogItem>(collection, entityType);
        for (const row of rows) await inMemory.saveBacklogItem(row);
        break;
      }
      case 'external_event': {
        const rows = await loadEntities<ExternalEvent>(collection, entityType);
        for (const row of rows) await inMemory.saveExternalEvent(row);
        break;
      }
      case 'event_route': {
        const rows = await loadEntities<EventRoute>(collection, entityType);
        for (const row of rows) await inMemory.saveEventRoute(row);
        break;
      }
      case 'outbound_action_record': {
        const rows = await loadEntities<OutboundActionRecord>(collection, entityType);
        for (const row of rows) await inMemory.saveOutboundActionRecord(row);
        break;
      }
      case 'capability_grant': {
        const rows = await loadEntities<CapabilityGrant>(collection, entityType);
        for (const row of rows) await inMemory.saveCapabilityGrant(row);
        break;
      }
      case 'grant_request': {
        const rows = await loadEntities<GrantRequest>(collection, entityType);
        for (const row of rows) await inMemory.saveGrantRequest(row);
        break;
      }
      case 'break_glass_invocation': {
        const rows = await loadEntities<BreakGlassInvocation>(collection, entityType);
        for (const row of rows) await inMemory.saveBreakGlassInvocation(row);
        break;
      }
      case 'promotion_request': {
        const rows = await loadEntities<PromotionRequest>(collection, entityType);
        for (const row of rows) await inMemory.savePromotionRequest(row);
        break;
      }
      case 'promotion': {
        const rows = await loadEntities<Promotion>(collection, entityType);
        for (const row of rows) await inMemory.savePromotion(row);
        break;
      }
      default:
        break;
    }
  }
}

async function withCollection<T>(
  db: Db,
  collectionName: string,
  runner: (collection: Collection<PersistedDocument>) => Promise<T>,
): Promise<T> {
  const collection = db.collection<PersistedDocument>(collectionName);
  await ensureIndexes(collection);
  return runner(collection);
}

export async function weaveMongoDbStateStore(opts: MongoDbStateStoreOptions): Promise<MongoDbStateStore> {
  const client = new MongoClient(opts.url);
  const inMemory = weaveInMemoryStateStore();
  const databaseName = opts.databaseName ?? 'live_agents';
  const collectionName = opts.collectionName ?? 'la_entities';

  const initialize = async (): Promise<void> => {
    await client.connect();
    const db = client.db(databaseName);
    await withCollection(db, collectionName, async (collection) => {
      // MongoDB Phase 4 stores each entity as a document snapshot.
      // The durable adapter rehydrates through the in-memory store so all
      // existing validation and authority checks remain centralized there.
      await hydrateInMemoryState(inMemory, collection);
    });
  };

  const close = async (): Promise<void> => {
    await client.close();
  };

  const store = new Proxy(inMemory as StateStore, {
    get(target, prop, receiver) {
      if (prop === '__kind') {
        return 'mongodb';
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
        // Run business logic first in the in-memory implementation, then persist
        // the resulting state snapshot to MongoDB.
        const result = await original.apply(target, args);
        const records = asPersistedRecords(String(prop), args, result);
        if (records.length === 0) {
          return result;
        }

        const db = client.db(databaseName);
        await withCollection(db, collectionName, async (collection) => {
          for (const record of records) {
            await upsertEntity(collection, record);
          }
        });

        return result;
      };
    },
  }) as MongoDbStateStore;

  await store.initialize();
  return store;
}