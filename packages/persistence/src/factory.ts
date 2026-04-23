import { CloudNoSqlPersistenceAdapter } from './adapters/cloud-nosql-adapter.js';
import { CosmosDbPersistenceAdapter } from './adapters/cosmosdb-adapter.js';
import { InMemoryPersistenceAdapter } from './adapters/in-memory-adapter.js';
import { MongoDbPersistenceAdapter } from './adapters/mongodb-adapter.js';
import { PostgresPersistenceAdapter } from './adapters/postgres-adapter.js';
import { RedisPersistenceAdapter } from './adapters/redis-adapter.js';
import { SqlitePersistenceAdapter } from './adapters/sqlite-adapter.js';
import type { PersistenceAdapter, PersistenceFactoryOptions } from './types.js';

export function createPersistenceAdapter(options: PersistenceFactoryOptions): PersistenceAdapter {
  switch (options.backend.kind) {
    case 'in-memory':
      return new InMemoryPersistenceAdapter();
    case 'postgres':
      return new PostgresPersistenceAdapter();
    case 'redis':
      return new RedisPersistenceAdapter();
    case 'sqlite':
      return new SqlitePersistenceAdapter();
    case 'mongodb':
      return new MongoDbPersistenceAdapter();
    case 'cloud-nosql':
      return new CloudNoSqlPersistenceAdapter();
    case 'cosmosdb':
      return new CosmosDbPersistenceAdapter();
    default:
      return assertNever(options.backend.kind);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled persistence backend: ${String(value)}`);
}
