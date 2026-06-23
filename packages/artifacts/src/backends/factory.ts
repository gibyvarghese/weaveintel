/**
 * Factory function for creating ArtifactStore instances.
 * Fixes the broken `createArtifactStore({ backend: '...' })` reference in docs.
 */
import type { ArtifactStore, ArtifactPolicy } from '@weaveintel/core';
import { createInMemoryArtifactStore } from '../store.js';

export interface ArtifactStoreMemoryOptions {
  backend: 'memory';
  policy?: ArtifactPolicy;
}

export interface ArtifactStoreSQLiteOptions {
  backend: 'sqlite';
  /** A pre-opened better-sqlite3 Database instance. */
  db: import('./sqlite-store.js').BetterSQLite3Database;
  policy?: ArtifactPolicy;
}

export interface ArtifactStoreFilesystemOptions {
  backend: 'filesystem';
  /** Root directory for artifact storage. Created if it doesn't exist. */
  path: string;
  policy?: ArtifactPolicy;
}

export type ArtifactStoreOptions =
  | ArtifactStoreMemoryOptions
  | ArtifactStoreSQLiteOptions
  | ArtifactStoreFilesystemOptions;

/**
 * Create an ArtifactStore from a configuration object.
 *
 * @example
 * // In-memory (testing / ephemeral)
 * const store = await createArtifactStore({ backend: 'memory' });
 *
 * @example
 * // SQLite (production — requires better-sqlite3)
 * import Database from 'better-sqlite3';
 * const rawDb = new Database('./geneweave.db');
 * const store = await createArtifactStore({ backend: 'sqlite', db: rawDb });
 *
 * @example
 * // Filesystem (development / single-instance)
 * const store = await createArtifactStore({ backend: 'filesystem', path: './artifacts' });
 */
export async function createArtifactStore(opts: ArtifactStoreOptions): Promise<ArtifactStore> {
  if (opts.backend === 'sqlite') {
    const { createSQLiteArtifactStore } = await import('./sqlite-store.js');
    return createSQLiteArtifactStore(opts.db, { policy: opts.policy });
  }
  if (opts.backend === 'filesystem') {
    const { createFilesystemArtifactStore } = await import('./filesystem-store.js');
    return createFilesystemArtifactStore(opts.path, { policy: opts.policy });
  }
  // 'memory' is the default
  return createInMemoryArtifactStore({ policy: opts.policy });
}
