/**
 * Phase K5 — Singleton accessor for the Kaggle live-agents StateStore.
 *
 * The live-agents framework persists meshes/agents/contracts/bindings in its
 * own SQLite file (separate from geneweave.db to avoid pragma collisions).
 * Path is configurable via env `LIVE_AGENTS_DB_PATH` (default: `./live-agents.db`).
 *
 * Admin routes and the seed function call `getKaggleLiveStore()`; example
 * scripts construct their own ephemeral stores.
 */

import { weaveSqliteStateStore, type SqliteStateStore } from '@weaveintel/live-agents';

let _store: SqliteStateStore | null = null;
let _pending: Promise<SqliteStateStore> | null = null;

export async function getKaggleLiveStore(): Promise<SqliteStateStore> {
  if (_store) return _store;
  if (_pending) return _pending;
  const path = process.env['LIVE_AGENTS_DB_PATH'] ?? './live-agents.db';
  _pending = weaveSqliteStateStore({ path }).then((s) => {
    _store = s;
    _pending = null;
    return s;
  });
  return _pending;
}

/** Test-only: reset the singleton so tests can swap stores between cases. */
export async function _resetKaggleLiveStoreForTests(replacement?: SqliteStateStore): Promise<void> {
  if (_store) {
    try { await _store.close(); } catch { /* ignore */ }
  }
  _store = replacement ?? null;
  _pending = null;
}
