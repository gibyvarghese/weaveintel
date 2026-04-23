import { AbstractPersistenceAdapter } from './abstract-adapter.js';

export class CosmosDbPersistenceAdapter extends AbstractPersistenceAdapter {
  public constructor() {
    super('cosmosdb', {
      transactions: false,
      ttl: true,
      optimisticConcurrency: true,
      pubsub: false,
      jsonQuery: true,
    });
  }
}
