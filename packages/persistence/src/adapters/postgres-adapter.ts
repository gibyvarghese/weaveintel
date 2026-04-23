import { AbstractPersistenceAdapter } from './abstract-adapter.js';

export class PostgresPersistenceAdapter extends AbstractPersistenceAdapter {
  public constructor() {
    super('postgres', {
      transactions: true,
      ttl: false,
      optimisticConcurrency: true,
      pubsub: true,
      jsonQuery: true,
    });
  }
}
