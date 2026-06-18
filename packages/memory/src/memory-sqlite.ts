/** SQLite-backed durable memory store. */

import type { MemoryEntry, MemoryFilter } from '@weaveintel/core';
import Database from 'better-sqlite3';
import { type DurableMemoryStore, applyMemoryQuery, parseStoredMemoryRow } from './memory-internal.js';

export function weaveSqliteMemoryStore(opts: { path: string }): DurableMemoryStore {
  const db = new Database(opts.path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const upsert = db.prepare(`
    INSERT INTO memory_entries (id, payload_json, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (id)
    DO UPDATE SET payload_json = excluded.payload_json, updated_at = CURRENT_TIMESTAMP
  `);
  const selectAll = db.prepare('SELECT payload_json FROM memory_entries ORDER BY updated_at ASC');
  const deleteById = db.prepare('DELETE FROM memory_entries WHERE id = ?');

  return {
    async write(_ctx, entries): Promise<void> {
      const transaction = db.transaction((rows: MemoryEntry[]) => {
        for (const row of rows) {
          upsert.run(row.id, JSON.stringify(row));
        }
      });
      transaction(entries);
    },
    async query(_ctx, options): Promise<MemoryEntry[]> {
      const rows = (selectAll.all() as Array<{ payload_json: string }>).map((row) => parseStoredMemoryRow(row.payload_json));
      return applyMemoryQuery(rows, options);
    },
    async delete(_ctx, ids): Promise<void> {
      const transaction = db.transaction((keys: string[]) => {
        for (const id of keys) {
          deleteById.run(id);
        }
      });
      transaction(ids);
    },
    async clear(_ctx, filter): Promise<void> {
      // L-25: server-side filtered DELETE using SQLite json_extract — avoids
      // loading all entries into memory before deleting.
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (filter?.tenantId)  { conditions.push(`json_extract(payload_json,'$.tenantId') = ?`);  params.push(filter.tenantId); }
      if (filter?.userId)    { conditions.push(`json_extract(payload_json,'$.userId') = ?`);    params.push(filter.userId); }
      if (filter?.sessionId) { conditions.push(`json_extract(payload_json,'$.sessionId') = ?`); params.push(filter.sessionId); }
      if (filter?.types?.length) {
        const placeholders = filter.types.map(() => '?').join(',');
        conditions.push(`json_extract(payload_json,'$.type') IN (${placeholders})`);
        params.push(...filter.types);
      }
      if (filter?.after)  { conditions.push(`json_extract(payload_json,'$.createdAt') > ?`); params.push(filter.after); }
      if (filter?.before) { conditions.push(`json_extract(payload_json,'$.createdAt') < ?`); params.push(filter.before); }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      db.prepare(`DELETE FROM memory_entries ${where}`).run(...params);
    },
    async close(): Promise<void> {
      db.close();
    },
  };
}
