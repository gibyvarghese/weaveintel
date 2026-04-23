import { createClient } from 'redis';
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
  RedisStateStore,
  StateStore,
  Team,
  TeamMembership,
} from './types.js';

type RedisStoreMode = 'coordination-only' | 'durable-explicit';

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

type RedisLiveAgentsClient = ReturnType<typeof createClient>;

export interface RedisStateStoreOptions {
  url: string;
  mode?: RedisStoreMode;
  keyPrefix?: string;
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

const DURABLE_ENTITY_TYPES: readonly PersistedEntityType[] = [
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
  'heartbeat_tick',
  'message',
  'backlog_item',
  'external_event',
  'event_route',
  'outbound_action_record',
  'capability_grant',
  'grant_request',
  'break_glass_invocation',
  'promotion_request',
  'promotion',
];

const COORDINATION_ENTITY_TYPES: readonly PersistedEntityType[] = ['heartbeat_tick'];

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

function shouldPersistEntity(mode: RedisStoreMode, entityType: PersistedEntityType): boolean {
  if (mode === 'durable-explicit') {
    return DURABLE_ENTITY_TYPES.includes(entityType);
  }
  return COORDINATION_ENTITY_TYPES.includes(entityType);
}

function buildEntityKey(prefix: string, entityType: PersistedEntityType, id: string): string {
  return `${prefix}:entity:${entityType}:${id}`;
}

function buildEntityIndexKey(prefix: string, entityType: PersistedEntityType): string {
  return `${prefix}:entity-index:${entityType}`;
}

function buildTickLockKey(prefix: string, tickId: string): string {
  return `${prefix}:tick-lock:${tickId}`;
}

async function upsertEntity(
  client: RedisLiveAgentsClient,
  prefix: string,
  record: PersistedRecord,
): Promise<void> {
  const entityKey = buildEntityKey(prefix, record.entityType, record.id);
  const indexKey = buildEntityIndexKey(prefix, record.entityType);

  const multi = client.multi();
  multi.set(entityKey, JSON.stringify(record.payload));
  multi.sAdd(indexKey, record.id);
  await multi.exec();
}

async function loadEntities<T extends PersistableEntity>(
  client: RedisLiveAgentsClient,
  prefix: string,
  entityType: PersistedEntityType,
): Promise<T[]> {
  const indexKey = buildEntityIndexKey(prefix, entityType);
  const ids = await client.sMembers(indexKey);
  if (ids.length === 0) {
    return [];
  }

  const keys = ids.map((id) => buildEntityKey(prefix, entityType, id));
  const values = await client.mGet(keys);

  return values
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => JSON.parse(value) as T);
}

function asPersistedRecords(methodName: string, args: unknown[], result: unknown): PersistedRecord[] {
  const directEntityType = ENTITY_TYPE_BY_SAVE_METHOD[methodName];
  if (directEntityType) {
    const payload = args[0] as PersistableEntity | undefined;
    if (!payload || typeof payload !== 'object' || !('id' in payload)) {
      return [];
    }

    return [{
      entityType: directEntityType,
      id: String(payload.id),
      payload,
    }];
  }

  const returningEntityType = ENTITY_TYPE_BY_RETURNING_MUTATOR[methodName];
  if (returningEntityType) {
    const payload = result as PersistableEntity | null;
    if (!payload || typeof payload !== 'object' || !('id' in payload)) {
      return [];
    }

    return [{
      entityType: returningEntityType,
      id: String(payload.id),
      payload,
    }];
  }

  const arrayEntityType = ARRAY_RETURNING_MUTATOR_ENTITY_TYPE[methodName];
  if (arrayEntityType) {
    const payloads = Array.isArray(result) ? (result as PersistableEntity[]) : [];
    return payloads
      .filter((payload) => payload && typeof payload === 'object' && 'id' in payload)
      .map((payload) => ({
        entityType: arrayEntityType,
        id: String(payload.id),
        payload,
      }));
  }

  return [];
}

function isTickClaimable(tick: HeartbeatTick, nowIso: string): boolean {
  const now = Date.parse(nowIso);
  if (tick.status === 'SCHEDULED') {
    return Date.parse(tick.scheduledFor) <= now;
  }
  if (tick.status === 'IN_PROGRESS') {
    if (!tick.leaseExpiresAt) {
      return true;
    }
    return Date.parse(tick.leaseExpiresAt) <= now;
  }
  return false;
}

function applyTickLease(
  tick: HeartbeatTick,
  workerId: string,
  nowIso: string,
  leaseDurationMs: number,
): HeartbeatTick {
  const nowMs = Date.parse(nowIso);
  const leaseExpiresAt = new Date(nowMs + Math.max(1, leaseDurationMs)).toISOString();

  return {
    ...tick,
    workerId,
    pickedUpAt: tick.pickedUpAt ?? nowIso,
    status: 'IN_PROGRESS',
    leaseExpiresAt,
  };
}

async function hydrateInMemoryState(
  client: RedisLiveAgentsClient,
  prefix: string,
  inMemory: StateStore,
  mode: RedisStoreMode,
): Promise<void> {
  const entityTypes = mode === 'durable-explicit' ? HYDRATION_ORDER : COORDINATION_ENTITY_TYPES;

  for (const entityType of entityTypes) {
    switch (entityType) {
      case 'mesh': {
        const rows = await loadEntities<Mesh>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveMesh(row);
        break;
      }
      case 'agent': {
        const rows = await loadEntities<LiveAgent>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveAgent(row);
        break;
      }
      case 'delegation_edge': {
        const rows = await loadEntities<DelegationEdge>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveDelegationEdge(row);
        break;
      }
      case 'team': {
        const rows = await loadEntities<Team>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveTeam(row);
        break;
      }
      case 'team_membership': {
        const rows = await loadEntities<TeamMembership>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveTeamMembership(row);
        break;
      }
      case 'cross_mesh_bridge': {
        const rows = await loadEntities<CrossMeshBridge>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveCrossMeshBridge(row);
        break;
      }
      case 'contract': {
        const rows = await loadEntities<AgentContract>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveContract(row);
        break;
      }
      case 'account': {
        const rows = await loadEntities<Account>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveAccount(row);
        break;
      }
      case 'account_binding': {
        const rows = await loadEntities<AccountBinding>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveAccountBinding(row);
        break;
      }
      case 'account_binding_request': {
        const rows = await loadEntities<AccountBindingRequest>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveAccountBindingRequest(row);
        break;
      }
      case 'heartbeat_tick': {
        const rows = await loadEntities<HeartbeatTick>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveHeartbeatTick(row);
        break;
      }
      case 'message': {
        const rows = await loadEntities<Message>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveMessage(row);
        break;
      }
      case 'backlog_item': {
        const rows = await loadEntities<BacklogItem>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveBacklogItem(row);
        break;
      }
      case 'external_event': {
        const rows = await loadEntities<ExternalEvent>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveExternalEvent(row);
        break;
      }
      case 'event_route': {
        const rows = await loadEntities<EventRoute>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveEventRoute(row);
        break;
      }
      case 'outbound_action_record': {
        const rows = await loadEntities<OutboundActionRecord>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveOutboundActionRecord(row);
        break;
      }
      case 'capability_grant': {
        const rows = await loadEntities<CapabilityGrant>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveCapabilityGrant(row);
        break;
      }
      case 'grant_request': {
        const rows = await loadEntities<GrantRequest>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveGrantRequest(row);
        break;
      }
      case 'break_glass_invocation': {
        const rows = await loadEntities<BreakGlassInvocation>(client, prefix, entityType);
        for (const row of rows) await inMemory.saveBreakGlassInvocation(row);
        break;
      }
      case 'promotion_request': {
        const rows = await loadEntities<PromotionRequest>(client, prefix, entityType);
        for (const row of rows) await inMemory.savePromotionRequest(row);
        break;
      }
      case 'promotion': {
        const rows = await loadEntities<Promotion>(client, prefix, entityType);
        for (const row of rows) await inMemory.savePromotion(row);
        break;
      }
      default:
        break;
    }
  }
}

// Phase 2 Redis adapter.
// - coordination-only: heartbeat ticks are coordinated through Redis to prevent double-claim.
// - durable-explicit: full entity persistence across restart using Redis JSON payload snapshots.
export function createRedisStateStoreAdapter(
  opts: RedisStateStoreOptions,
  createInMemoryStore: () => StateStore,
): RedisStateStore {
  const mode: RedisStoreMode = opts.mode ?? 'coordination-only';
  const keyPrefix = opts.keyPrefix ?? 'weave:live-agents';

  const inMemory = createInMemoryStore();
  const client = createClient({ url: opts.url });

  let initialized = false;
  let initPromise: Promise<void> | null = null;

  const ensureInitialized = async (): Promise<void> => {
    if (initialized) {
      return;
    }
    if (initPromise) {
      await initPromise;
      return;
    }

    initPromise = (async () => {
      if (!client.isOpen) {
        await client.connect();
      }
      await hydrateInMemoryState(client, keyPrefix, inMemory, mode);
      initialized = true;
    })();

    try {
      await initPromise;
    } finally {
      initPromise = null;
    }
  };

  const persistRecords = async (records: PersistedRecord[]): Promise<void> => {
    const filtered = records.filter((record) => shouldPersistEntity(mode, record.entityType));
    if (filtered.length === 0) {
      return;
    }

    await ensureInitialized();

    for (const record of filtered) {
      await upsertEntity(client, keyPrefix, record);
    }
  };

  const claimNextTicksWithRedis = async (
    workerId: string,
    nowIso: string,
    limit: number,
    leaseDurationMs = 30_000,
  ): Promise<HeartbeatTick[]> => {
    await ensureInitialized();

    const tickIds = await client.sMembers(buildEntityIndexKey(keyPrefix, 'heartbeat_tick'));
    const ticks: HeartbeatTick[] = [];

    for (const tickId of tickIds) {
      const value = await client.get(buildEntityKey(keyPrefix, 'heartbeat_tick', tickId));
      if (!value) {
        continue;
      }
      const tick = JSON.parse(value) as HeartbeatTick;
      if (!isTickClaimable(tick, nowIso)) {
        continue;
      }
      ticks.push(tick);
    }

    ticks.sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));

    const claimed: HeartbeatTick[] = [];
    for (const candidate of ticks) {
      if (claimed.length >= Math.max(0, limit)) {
        break;
      }

      const lockKey = buildTickLockKey(keyPrefix, candidate.id);
      const lock = await client.set(lockKey, workerId, {
        NX: true,
        PX: Math.max(1000, leaseDurationMs),
      });

      if (!lock) {
        continue;
      }

      try {
        const latestValue = await client.get(buildEntityKey(keyPrefix, 'heartbeat_tick', candidate.id));
        if (!latestValue) {
          continue;
        }

        const latestTick = JSON.parse(latestValue) as HeartbeatTick;
        if (!isTickClaimable(latestTick, nowIso)) {
          continue;
        }

        const leasedTick = applyTickLease(latestTick, workerId, nowIso, leaseDurationMs);
        await inMemory.saveHeartbeatTick(leasedTick);
        await persistRecords([
          {
            entityType: 'heartbeat_tick',
            id: leasedTick.id,
            payload: leasedTick,
          },
        ]);
        claimed.push(leasedTick);
      } finally {
        await client.del(lockKey);
      }
    }

    return claimed;
  };

  const initialize = async (): Promise<void> => {
    await ensureInitialized();
  };

  const close = async (): Promise<void> => {
    if (client.isOpen) {
      await client.quit();
    }
    initialized = false;
  };

  const store = new Proxy(inMemory as StateStore, {
    get(target, prop, receiver) {
      if (prop === '__kind') {
        return 'redis';
      }
      if (prop === 'mode') {
        return mode;
      }
      if (prop === 'initialize') {
        return initialize;
      }
      if (prop === 'close') {
        return close;
      }
      if (prop === 'claimNextTicks') {
        return claimNextTicksWithRedis;
      }

      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== 'function') {
        return original;
      }

      return async (...args: unknown[]) => {
        await ensureInitialized();

        const result = await original.apply(target, args);
        const methodName = String(prop);
        const updates = asPersistedRecords(methodName, args, result);

        await persistRecords(updates);
        return result;
      };
    },
  }) as RedisStateStore;

  return store;
}
