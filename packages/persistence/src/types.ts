export type PersistenceBackendKind =
  | 'in-memory'
  | 'postgres'
  | 'redis'
  | 'sqlite'
  | 'mongodb'
  | 'cloud-nosql'
  | 'cosmosdb';

export type PersistenceDomain =
  | 'agent-memory'
  | 'live-agents-state'
  | 'contracts'
  | 'events'
  | 'artifacts'
  | 'caches';

export interface PersistenceBackendConfig {
  kind: PersistenceBackendKind;
  provider?: 'dynamodb' | 'cosmosdb';
  connectionString?: string;
  database?: string;
  namespace?: string;
  schema?: string;
}

export interface PersistenceHealth {
  ok: boolean;
  backend: PersistenceBackendKind;
  details?: string;
}

export interface PersistenceCapabilities {
  transactions: boolean;
  ttl: boolean;
  optimisticConcurrency: boolean;
  pubsub: boolean;
  jsonQuery: boolean;
}

export interface PersistenceAdapter {
  readonly kind: PersistenceBackendKind;
  readonly capabilities: PersistenceCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  health(): Promise<PersistenceHealth>;
}

export interface PersistenceFactoryOptions {
  backend: PersistenceBackendConfig;
}
