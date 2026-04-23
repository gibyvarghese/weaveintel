import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  type AttributeDefinition,
  type KeySchemaElement,
  ResourceNotFoundException,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  Account,
  AccountBinding,
  AccountBindingRequest,
  AgentContract,
  BacklogItem,
  BreakGlassInvocation,
  CloudNoSqlStateStore,
  CapabilityGrant,
  CrossMeshBridge,
  DelegationEdge,
  DynamoDbStateStore,
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

interface PersistedItem {
  entityType: PersistedEntityType;
  entityId: string;
  payload: PersistableEntity;
  updatedAt: string;
}

export interface CloudNoSqlStateStoreOptions {
  provider: 'dynamodb';
  dynamodb: {
    endpoint?: string;
    region?: string;
    tableName?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
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

const KEY_SCHEMA: KeySchemaElement[] = [
  { AttributeName: 'entityType', KeyType: 'HASH' },
  { AttributeName: 'entityId', KeyType: 'RANGE' },
];

const ATTRIBUTE_DEFINITIONS: AttributeDefinition[] = [
  { AttributeName: 'entityType', AttributeType: 'S' },
  { AttributeName: 'entityId', AttributeType: 'S' },
];

function createDynamoClients(options: CloudNoSqlStateStoreOptions['dynamodb']): {
  client: DynamoDBClient;
  docClient: DynamoDBDocumentClient;
} {
  const region = options.region ?? 'us-east-1';
  const useLocalCredentials = Boolean(options.endpoint);

  const client = new DynamoDBClient({
    region,
    endpoint: options.endpoint,
    credentials: useLocalCredentials
      ? {
        accessKeyId: options.accessKeyId ?? 'local',
        secretAccessKey: options.secretAccessKey ?? 'local',
      }
      : undefined,
  });

  return {
    client,
    docClient: DynamoDBDocumentClient.from(client),
  };
}

async function ensureTable(client: DynamoDBClient, tableName: string): Promise<void> {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return;
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) {
      throw error;
    }
  }

  await client.send(new CreateTableCommand({
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: KEY_SCHEMA,
    AttributeDefinitions: ATTRIBUTE_DEFINITIONS,
  }));

  await waitUntilTableExists(
    { client, maxWaitTime: 30 },
    { TableName: tableName },
  );
}

async function upsertEntity(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  record: PersistedRecord,
): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: tableName,
    Item: {
      entityType: record.entityType,
      entityId: record.id,
      payload: record.payload,
      updatedAt: new Date().toISOString(),
    },
  }));
}

async function loadEntities<T extends PersistableEntity>(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  entityType: PersistedEntityType,
): Promise<T[]> {
  const result = await docClient.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'entityType = :entityType',
    ExpressionAttributeValues: {
      ':entityType': entityType,
    },
  }));

  const items = (result.Items ?? []) as PersistedItem[];
  return items
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .map((item) => item.payload as T);
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
  docClient: DynamoDBDocumentClient,
  tableName: string,
): Promise<void> {
  for (const entityType of HYDRATION_ORDER) {
    switch (entityType) {
      case 'mesh': {
        const rows = await loadEntities<Mesh>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveMesh(row);
        break;
      }
      case 'agent': {
        const rows = await loadEntities<LiveAgent>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveAgent(row);
        break;
      }
      case 'delegation_edge': {
        const rows = await loadEntities<DelegationEdge>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveDelegationEdge(row);
        break;
      }
      case 'team': {
        const rows = await loadEntities<Team>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveTeam(row);
        break;
      }
      case 'team_membership': {
        const rows = await loadEntities<TeamMembership>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveTeamMembership(row);
        break;
      }
      case 'cross_mesh_bridge': {
        const rows = await loadEntities<CrossMeshBridge>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveCrossMeshBridge(row);
        break;
      }
      case 'contract': {
        const rows = await loadEntities<AgentContract>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveContract(row);
        break;
      }
      case 'account': {
        const rows = await loadEntities<Account>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveAccount(row);
        break;
      }
      case 'account_binding': {
        const rows = await loadEntities<AccountBinding>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveAccountBinding(row);
        break;
      }
      case 'account_binding_request': {
        const rows = await loadEntities<AccountBindingRequest>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveAccountBindingRequest(row);
        break;
      }
      case 'heartbeat_tick': {
        const rows = await loadEntities<HeartbeatTick>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveHeartbeatTick(row);
        break;
      }
      case 'message': {
        const rows = await loadEntities<Message>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveMessage(row);
        break;
      }
      case 'backlog_item': {
        const rows = await loadEntities<BacklogItem>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveBacklogItem(row);
        break;
      }
      case 'external_event': {
        const rows = await loadEntities<ExternalEvent>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveExternalEvent(row);
        break;
      }
      case 'event_route': {
        const rows = await loadEntities<EventRoute>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveEventRoute(row);
        break;
      }
      case 'outbound_action_record': {
        const rows = await loadEntities<OutboundActionRecord>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveOutboundActionRecord(row);
        break;
      }
      case 'capability_grant': {
        const rows = await loadEntities<CapabilityGrant>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveCapabilityGrant(row);
        break;
      }
      case 'grant_request': {
        const rows = await loadEntities<GrantRequest>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveGrantRequest(row);
        break;
      }
      case 'break_glass_invocation': {
        const rows = await loadEntities<BreakGlassInvocation>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.saveBreakGlassInvocation(row);
        break;
      }
      case 'promotion_request': {
        const rows = await loadEntities<PromotionRequest>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.savePromotionRequest(row);
        break;
      }
      case 'promotion': {
        const rows = await loadEntities<Promotion>(docClient, tableName, entityType);
        for (const row of rows) await inMemory.savePromotion(row);
        break;
      }
      default:
        break;
    }
  }
}

export async function weaveDynamoDbStateStore(options: CloudNoSqlStateStoreOptions['dynamodb']): Promise<DynamoDbStateStore> {
  const inMemory = weaveInMemoryStateStore();
  const tableName = options.tableName ?? 'la_entities';
  const { client, docClient } = createDynamoClients(options);

  const initialize = async (): Promise<void> => {
    await ensureTable(client, tableName);
    // Phase 5 stores each entity family under its own partition key (entityType)
    // with entityId as the sort key. This keeps the first concrete cloud-NoSQL
    // implementation provider-aligned while still allowing deterministic hydration.
    await hydrateInMemoryState(inMemory, docClient, tableName);
  };

  const close = async (): Promise<void> => {
    await client.destroy();
  };

  const store = new Proxy(inMemory as StateStore, {
    get(target, prop, receiver) {
      if (prop === '__kind') {
        return 'cloud-nosql';
      }
      if (prop === 'provider') {
        return 'dynamodb';
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
        const result = await original.apply(target, args);
        const records = asPersistedRecords(String(prop), args, result);
        for (const record of records) {
          await upsertEntity(docClient, tableName, record);
        }
        return result;
      };
    },
  }) as DynamoDbStateStore;

  await store.initialize();
  return store;
}

export async function weaveCloudNoSqlStateStore(options: CloudNoSqlStateStoreOptions): Promise<CloudNoSqlStateStore> {
  switch (options.provider) {
    case 'dynamodb':
      return weaveDynamoDbStateStore(options.dynamodb);
    default:
      return assertNever(options.provider);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported cloud no-sql provider: ${String(value)}`);
}