import { AbstractPersistenceAdapter } from './abstract-adapter.js';

export class SqlitePersistenceAdapter extends AbstractPersistenceAdapter {
  public constructor() {
    super('sqlite', {
      transactions: true,
      ttl: false,
      optimisticConcurrency: false,
      pubsub: false,
      jsonQuery: false,
    });
  }
}
