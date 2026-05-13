/**
 * GeneWeave: encryption bootstrap. Constructs a TenantKeyManager wired to
 * the SQLite-backed EncryptionStore and audit emitter. Best-effort: returns
 * `null` when `WEAVE_ENCRYPTION_MASTER_KEY` is missing and devGenerate is
 * off, so the server can boot without encryption configured. Idempotent —
 * safe to call on every startup.
 */

import { LocalKmsProvider, loadMasterKeyFromEnv, weaveTenantKeyManager, type TenantKeyManager } from '@weaveintel/encryption';
import type { DatabaseAdapter } from '../db-types.js';
import { createDbEncryptionStore } from './db-encryption-store.js';
import { createDbEncryptionAuditEmitter } from './db-audit-emitter.js';

export interface BootstrapEncryptionOptions {
  /** When true and master-key env var is missing, generate a random key (DEV ONLY). */
  readonly devGenerateIfMissing?: boolean;
  /** Override env var name. Default: 'WEAVE_ENCRYPTION_MASTER_KEY'. */
  readonly envVar?: string;
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface BootstrapEncryptionResult {
  readonly manager: TenantKeyManager;
  readonly source: 'env' | 'dev-generated';
}

/**
 * Construct and return the geneweave encryption key manager. Returns `null`
 * (and logs a single warning) when the master key cannot be loaded — this
 * keeps geneweave bootable for environments that have not opted into
 * tenant encryption yet.
 */
export function bootstrapEncryption(
  db: DatabaseAdapter,
  opts: BootstrapEncryptionOptions = {},
): BootstrapEncryptionResult | null {
  const log = opts.log ?? ((msg, meta) => console.log(`[encryption] ${msg}`, meta ?? {}));
  let loaded;
  try {
    loaded = loadMasterKeyFromEnv({
      ...(opts.envVar !== undefined ? { envVar: opts.envVar } : {}),
      ...(opts.devGenerateIfMissing !== undefined ? { devGenerateIfMissing: opts.devGenerateIfMissing } : {}),
    });
  } catch (err) {
    log('master key unavailable — encryption disabled at boot', { err: (err as Error).message });
    return null;
  }
  const kms = new LocalKmsProvider({ masterKey: loaded.key });
  const store = createDbEncryptionStore(db);
  const audit = createDbEncryptionAuditEmitter(db);
  const manager = weaveTenantKeyManager({ store, kms, audit });
  log(`encryption bootstrapped (source: ${loaded.source}, kms: local)`);
  return { manager, source: loaded.source };
}
