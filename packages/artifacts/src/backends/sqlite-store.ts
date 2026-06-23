/**
 * SQLite-backed ArtifactStore.
 *
 * Requires better-sqlite3 to be available in the host application.
 * Pass in a pre-opened Database instance. The store operates on the
 * `artifacts` and `artifact_versions` tables created by migration m77.
 *
 * This module uses a dynamic import for better-sqlite3 so that the
 * @weaveintel/artifacts package itself does not take a hard dependency
 * on better-sqlite3. The caller (geneWeave) already has it available.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type {
  Artifact,
  ArtifactStore,
  ArtifactVersion,
  ArtifactListFilter,
  ArtifactType,
  ArtifactScope,
  ArtifactPolicy,
} from '@weaveintel/core';
import { estimateSize } from '../artifact.js';
import { validateArtifact } from '../policy.js';

// We accept the DB as `unknown` so the package does not import better-sqlite3
// types directly. The interface we need is just `.prepare(sql).run/get/all(...)`.
export interface BetterSQLite3Database {
  prepare(sql: string): {
    run(...args: unknown[]): { lastInsertRowid: number | bigint };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
}

export interface SQLiteArtifactStoreOptions {
  policy?: ArtifactPolicy;
}

interface ArtifactRow {
  id: string;
  name: string;
  type: string;
  mime_type: string;
  data_text: string | null;
  data_blob: Buffer | null;
  size_bytes: number | null;
  version: number;
  session_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  run_id: string | null;
  tags: string | null;
  metadata: string | null;
  policy_id: string | null;
  scope: string;
  created_at: string;
  updated_at: string | null;
}

interface VersionRow {
  id: string;
  artifact_id: string;
  version: number;
  data_text: string | null;
  data_blob: Buffer | null;
  changelog: string | null;
  created_at: string;
}

function rowToArtifact(row: ArtifactRow): Artifact {
  let data: unknown;
  if (row.data_text !== null) {
    try { data = JSON.parse(row.data_text); } catch { data = row.data_text; }
  } else {
    data = row.data_blob ?? null;
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type as ArtifactType,
    mimeType: row.mime_type,
    data,
    sizeBytes: row.size_bytes ?? undefined,
    version: row.version,
    sessionId: row.session_id ?? undefined,
    userId: row.user_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    runId: row.run_id ?? undefined,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    scope: (row.scope as ArtifactScope) ?? 'session',
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
  };
}

function versionRowToArtifactVersion(row: VersionRow): ArtifactVersion {
  let data: unknown;
  if (row.data_text !== null) {
    try { data = JSON.parse(row.data_text); } catch { data = row.data_text; }
  } else {
    data = row.data_blob ?? null;
  }
  return {
    id: row.id,
    artifactId: row.artifact_id,
    version: row.version,
    data,
    changelog: row.changelog ?? undefined,
    createdAt: row.created_at,
  };
}

function serializeData(data: unknown): { data_text: string | null; data_blob: Buffer | null } {
  if (Buffer.isBuffer(data)) return { data_text: null, data_blob: data };
  if (data instanceof Uint8Array) return { data_text: null, data_blob: Buffer.from(data) };
  if (data instanceof ArrayBuffer) return { data_text: null, data_blob: Buffer.from(data) };
  if (data === null || data === undefined) return { data_text: null, data_blob: null };
  if (typeof data === 'string') return { data_text: data, data_blob: null };
  return { data_text: JSON.stringify(data), data_blob: null };
}

/**
 * Create an ArtifactStore backed by a better-sqlite3 Database instance.
 * The `artifacts` and `artifact_versions` tables must already exist
 * (created by migration m77-artifacts).
 */
export function createSQLiteArtifactStore(
  db: BetterSQLite3Database,
  opts?: SQLiteArtifactStoreOptions,
): ArtifactStore {
  function enforcePolicy(artifact: Artifact): void {
    if (!opts?.policy) return;
    const result = validateArtifact(artifact, opts.policy);
    if (!result.valid) {
      throw new Error(`ArtifactStore policy violation: ${result.violations.join('; ')}`);
    }
  }

  return {
    async save(input) {
      const id = newUUIDv7();
      const now = new Date().toISOString();
      const sizeBytes = input.sizeBytes ?? estimateSize(input.data);
      const { data_text, data_blob } = serializeData(input.data);
      const artifact: Artifact = {
        ...input,
        id,
        createdAt: now,
        sizeBytes,
        scope: input.scope ?? 'session',
      };
      enforcePolicy(artifact);

      db.prepare(`
        INSERT INTO artifacts
          (id, name, type, mime_type, data_text, data_blob, size_bytes, version,
           session_id, user_id, agent_id, run_id, tags, metadata, scope, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id, input.name, input.type, input.mimeType, data_text, data_blob,
        sizeBytes, 1,
        input.sessionId ?? null,
        input.userId ?? null,
        input.agentId ?? null,
        input.runId ?? null,
        input.tags ? JSON.stringify(input.tags) : null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.scope ?? 'session',
        now,
      );

      const verId = newUUIDv7();
      db.prepare(`
        INSERT INTO artifact_versions (id, artifact_id, version, data_text, data_blob, changelog, created_at)
        VALUES (?,?,?,?,?,?,?)
      `).run(verId, id, 1, data_text, data_blob, null, now);

      return artifact;
    },

    async update(artifactId, patch, changelog) {
      const existing = await this.get(artifactId);
      if (!existing) throw new Error(`Artifact not found: ${artifactId}`);
      const now = new Date().toISOString();
      const nextVersion = existing.version + 1;
      const mergedData = patch.data !== undefined ? patch.data : existing.data;
      const { data_text, data_blob } = serializeData(mergedData);
      const sizeBytes = patch.data !== undefined ? estimateSize(mergedData) : existing.sizeBytes;
      const updated: Artifact = {
        ...existing,
        ...patch,
        id: existing.id,
        createdAt: existing.createdAt,
        version: nextVersion,
        updatedAt: now,
        sizeBytes,
      };
      enforcePolicy(updated);

      db.prepare(`
        UPDATE artifacts SET
          name=?, type=?, mime_type=?, data_text=?, data_blob=?, size_bytes=?,
          version=?, session_id=?, user_id=?, agent_id=?, run_id=?,
          tags=?, metadata=?, scope=?, updated_at=?
        WHERE id=?
      `).run(
        updated.name, updated.type, updated.mimeType,
        data_text, data_blob, sizeBytes,
        nextVersion,
        updated.sessionId ?? null,
        updated.userId ?? null,
        updated.agentId ?? null,
        updated.runId ?? null,
        updated.tags ? JSON.stringify(updated.tags) : null,
        updated.metadata ? JSON.stringify(updated.metadata) : null,
        updated.scope ?? 'session',
        now,
        artifactId,
      );

      const verId = newUUIDv7();
      db.prepare(`
        INSERT INTO artifact_versions (id, artifact_id, version, data_text, data_blob, changelog, created_at)
        VALUES (?,?,?,?,?,?,?)
      `).run(verId, artifactId, nextVersion, data_text, data_blob, changelog ?? null, now);

      return updated;
    },

    async get(artifactId) {
      const row = db.prepare(`SELECT * FROM artifacts WHERE id=? LIMIT 1`).get(artifactId);
      if (!row) return null;
      return rowToArtifact(row as ArtifactRow);
    },

    async list(filter?: ArtifactListFilter) {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (filter?.type) {
        const types = Array.isArray(filter.type) ? filter.type : [filter.type];
        conditions.push(`type IN (${types.map(() => '?').join(',')})`);
        params.push(...types);
      }
      if (filter?.runId) { conditions.push('run_id=?'); params.push(filter.runId); }
      if (filter?.agentId) { conditions.push('agent_id=?'); params.push(filter.agentId); }
      if (filter?.sessionId) { conditions.push('session_id=?'); params.push(filter.sessionId); }
      if (filter?.userId) { conditions.push('user_id=?'); params.push(filter.userId); }
      if (filter?.scope) { conditions.push('scope=?'); params.push(filter.scope); }

      let sql = 'SELECT * FROM artifacts';
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY created_at DESC';
      if (filter?.limit) { sql += ' LIMIT ?'; params.push(filter.limit); }
      if (filter?.offset) { sql += ' OFFSET ?'; params.push(filter.offset); }

      const rows = db.prepare(sql).all(...params) as ArtifactRow[];
      let results = rows.map(rowToArtifact);

      // Tag filtering done in-memory (JSON array stored as TEXT)
      if (filter?.tags && filter.tags.length > 0) {
        const required = filter.tags;
        results = results.filter((a) => {
          if (!a.tags) return false;
          return required.every((t: string) => a.tags!.includes(t));
        });
      }

      return results;
    },

    async delete(artifactId) {
      // artifact_versions cascade-deletes via FK
      db.prepare(`DELETE FROM artifacts WHERE id=?`).run(artifactId);
    },

    async getVersions(artifactId) {
      const rows = db.prepare(
        `SELECT * FROM artifact_versions WHERE artifact_id=? ORDER BY version ASC`,
      ).all(artifactId) as VersionRow[];
      return rows.map(versionRowToArtifactVersion);
    },
  };
}
