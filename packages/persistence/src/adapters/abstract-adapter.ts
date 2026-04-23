import type {
  PersistenceAdapter,
  PersistenceBackendKind,
  PersistenceCapabilities,
  PersistenceHealth,
} from '../types.js';

export abstract class AbstractPersistenceAdapter implements PersistenceAdapter {
  public readonly kind: PersistenceBackendKind;
  public readonly capabilities: PersistenceCapabilities;

  protected constructor(kind: PersistenceBackendKind, capabilities: PersistenceCapabilities) {
    this.kind = kind;
    this.capabilities = capabilities;
  }

  public async connect(): Promise<void> {
    return Promise.resolve();
  }

  public async disconnect(): Promise<void> {
    return Promise.resolve();
  }

  public async health(): Promise<PersistenceHealth> {
    return {
      ok: true,
      backend: this.kind,
      details: 'adapter initialized',
    };
  }
}
