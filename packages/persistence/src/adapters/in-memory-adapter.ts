import { AbstractPersistenceAdapter } from './abstract-adapter.js';

export class InMemoryPersistenceAdapter extends AbstractPersistenceAdapter {
  public constructor() {
    super('in-memory', {
      transactions: false,
      ttl: false,
      optimisticConcurrency: false,
      pubsub: false,
      jsonQuery: false,
    });
  }
}
