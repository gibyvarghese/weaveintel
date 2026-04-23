import { AbstractPersistenceAdapter } from './abstract-adapter.js';

export class MongoDbPersistenceAdapter extends AbstractPersistenceAdapter {
  public constructor() {
    super('mongodb', {
      transactions: true,
      ttl: true,
      optimisticConcurrency: true,
      pubsub: false,
      jsonQuery: true,
    });
  }
}
