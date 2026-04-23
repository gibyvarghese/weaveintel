import { AbstractPersistenceAdapter } from './abstract-adapter.js';

export class CloudNoSqlPersistenceAdapter extends AbstractPersistenceAdapter {
  public constructor() {
    super('cloud-nosql', {
      transactions: false,
      ttl: true,
      optimisticConcurrency: true,
      pubsub: false,
      jsonQuery: false,
    });
  }
}