import type { PersistenceBackendKind } from './types.js';

export function parsePersistenceBackendKind(input: string | undefined): PersistenceBackendKind {
  const value = (input ?? 'in-memory').toLowerCase();

  switch (value) {
    case 'in-memory':
    case 'memory':
      return 'in-memory';
    case 'postgres':
    case 'postgresql':
      return 'postgres';
    case 'redis':
      return 'redis';
    case 'sqlite':
      return 'sqlite';
    case 'mongodb':
    case 'mongo':
      return 'mongodb';
    case 'cosmosdb':
    case 'cosmos':
      return 'cosmosdb';
    default:
      throw new Error(`Unsupported persistence backend: ${input ?? '<undefined>'}`);
  }
}
