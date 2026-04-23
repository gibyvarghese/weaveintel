import { AbstractPersistenceAdapter } from './abstract-adapter.js';

export class RedisPersistenceAdapter extends AbstractPersistenceAdapter {
  public constructor() {
    super('redis', {
      transactions: false,
      ttl: true,
      optimisticConcurrency: true,
      pubsub: true,
      jsonQuery: false,
    });
  }
}
