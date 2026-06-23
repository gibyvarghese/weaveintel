/**
 * Filesystem-backed ArtifactStore.
 *
 * Layout on disk:
 *   {basePath}/{artifactId}/meta.json      — artifact metadata + current data
 *   {basePath}/{artifactId}/v{n}.dat       — raw binary version data (for binary types)
 *   {basePath}/{artifactId}/v{n}.txt       — text/JSON version data (for text types)
 *   {basePath}/_index.json                 — flat index for fast list() without readdir
 *
 * Suitable for development and single-process production. Not recommended for
 * multi-instance deployments — use the SQLite or S3 backend there.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
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

export interface FilesystemArtifactStoreOptions {
  policy?: ArtifactPolicy;
}

// ── Index entry stored in _index.json for fast listing ───────────────────────

interface IndexEntry {
  id: string;
  name: string;
  type: string;
  mimeType: string;
  sizeBytes: number | undefined;
  version: number;
  sessionId: string | undefined;
  userId: string | undefined;
  agentId: string | undefined;
  runId: string | undefined;
  tags: string[] | undefined;
  scope: string;
  createdAt: string;
  updatedAt: string | undefined;
}

// ── Disk format for meta.json ─────────────────────────────────────────────────

interface MetaFile {
  id: string;
  name: string;
  type: string;
  mimeType: string;
  sizeBytes: number | undefined;
  version: number;
  sessionId: string | undefined;
  userId: string | undefined;
  agentId: string | undefined;
  runId: string | undefined;
  tags: string[] | undefined;
  metadata: Record<string, unknown> | undefined;
  policyId: string | undefined;
  scope: string;
  createdAt: string;
  updatedAt: string | undefined;
  // 'text' | 'binary' — controls which version file extension to use
  dataKind: 'text' | 'binary';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function artifactDir(basePath: string, id: string): string {
  return path.join(basePath, id);
}

function metaPath(basePath: string, id: string): string {
  return path.join(artifactDir(basePath, id), 'meta.json');
}

function versionPath(basePath: string, id: string, version: number, kind: 'text' | 'binary'): string {
  const ext = kind === 'binary' ? '.dat' : '.txt';
  return path.join(artifactDir(basePath, id), `v${version}${ext}`);
}

function indexPath(basePath: string): string {
  return path.join(basePath, '_index.json');
}

function readIndex(basePath: string): Map<string, IndexEntry> {
  try {
    const raw = fs.readFileSync(indexPath(basePath), 'utf8');
    const entries = JSON.parse(raw) as IndexEntry[];
    return new Map(entries.map((e) => [e.id, e]));
  } catch {
    return new Map();
  }
}

function writeIndex(basePath: string, index: Map<string, IndexEntry>): void {
  fs.writeFileSync(indexPath(basePath), JSON.stringify([...index.values()], null, 2), 'utf8');
}

function readMeta(basePath: string, id: string): MetaFile | null {
  try {
    const raw = fs.readFileSync(metaPath(basePath, id), 'utf8');
    return JSON.parse(raw) as MetaFile;
  } catch {
    return null;
  }
}

function writeMeta(basePath: string, meta: MetaFile): void {
  const dir = artifactDir(basePath, meta.id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(metaPath(basePath, meta.id), JSON.stringify(meta, null, 2), 'utf8');
}

function dataKind(data: unknown): 'text' | 'binary' {
  if (Buffer.isBuffer(data) || data instanceof Uint8Array || data instanceof ArrayBuffer) return 'binary';
  return 'text';
}

function serializeData(data: unknown): { kind: 'text' | 'binary'; payload: Buffer | string } {
  if (Buffer.isBuffer(data)) return { kind: 'binary', payload: data };
  if (data instanceof Uint8Array) return { kind: 'binary', payload: Buffer.from(data) };
  if (data instanceof ArrayBuffer) return { kind: 'binary', payload: Buffer.from(data) };
  if (data === null || data === undefined) return { kind: 'text', payload: '' };
  if (typeof data === 'string') return { kind: 'text', payload: data };
  return { kind: 'text', payload: JSON.stringify(data) };
}

function readVersionData(basePath: string, id: string, version: number, kind: 'text' | 'binary'): unknown {
  const p = versionPath(basePath, id, version, kind);
  if (!fs.existsSync(p)) return null;
  if (kind === 'binary') return fs.readFileSync(p);
  const raw = fs.readFileSync(p, 'utf8');
  try { return JSON.parse(raw); } catch { return raw; }
}

function metaToArtifact(meta: MetaFile, basePath: string): Artifact {
  const data = readVersionData(basePath, meta.id, meta.version, meta.dataKind);
  return {
    id: meta.id,
    name: meta.name,
    type: meta.type as ArtifactType,
    mimeType: meta.mimeType,
    data,
    sizeBytes: meta.sizeBytes,
    version: meta.version,
    sessionId: meta.sessionId,
    userId: meta.userId,
    agentId: meta.agentId,
    runId: meta.runId,
    tags: meta.tags,
    metadata: meta.metadata,
    scope: (meta.scope as ArtifactScope) ?? 'session',
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

function metaToIndexEntry(meta: MetaFile): IndexEntry {
  return {
    id: meta.id,
    name: meta.name,
    type: meta.type,
    mimeType: meta.mimeType,
    sizeBytes: meta.sizeBytes,
    version: meta.version,
    sessionId: meta.sessionId,
    userId: meta.userId,
    agentId: meta.agentId,
    runId: meta.runId,
    tags: meta.tags,
    scope: meta.scope,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

function indexEntryMatchesFilter(e: IndexEntry, filter: ArtifactListFilter): boolean {
  if (filter.type) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.includes(e.type as ArtifactType)) return false;
  }
  if (filter.sessionId && e.sessionId !== filter.sessionId) return false;
  if (filter.userId && e.userId !== filter.userId) return false;
  if (filter.agentId && e.agentId !== filter.agentId) return false;
  if (filter.runId && e.runId !== filter.runId) return false;
  if (filter.scope && e.scope !== filter.scope) return false;
  if (filter.tags && filter.tags.length > 0) {
    if (!e.tags) return false;
    if (!filter.tags.every((t) => e.tags!.includes(t))) return false;
  }
  return true;
}

/**
 * Create an ArtifactStore backed by the local filesystem.
 *
 * @param basePath - Root directory for artifact storage. Created if it doesn't exist.
 * @param opts     - Optional policy enforcement and other options.
 */
export function createFilesystemArtifactStore(
  basePath: string,
  opts?: FilesystemArtifactStoreOptions,
): ArtifactStore {
  // Ensure the base directory exists
  if (!fs.existsSync(basePath)) fs.mkdirSync(basePath, { recursive: true });

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
      const artifact: Artifact = {
        ...input,
        id,
        createdAt: now,
        sizeBytes,
        scope: input.scope ?? 'session',
        version: 1,
      };
      enforcePolicy(artifact);

      const { kind, payload } = serializeData(input.data);
      const meta: MetaFile = {
        id,
        name: input.name,
        type: input.type,
        mimeType: input.mimeType,
        sizeBytes,
        version: 1,
        sessionId: input.sessionId,
        userId: input.userId,
        agentId: input.agentId,
        runId: input.runId,
        tags: input.tags,
        metadata: input.metadata,
        policyId: (input as { policyId?: string }).policyId,
        scope: input.scope ?? 'session',
        createdAt: now,
        updatedAt: undefined,
        dataKind: kind,
      };

      writeMeta(basePath, meta);
      const vPath = versionPath(basePath, id, 1, kind);
      if (kind === 'binary') {
        fs.writeFileSync(vPath, payload as Buffer);
      } else {
        fs.writeFileSync(vPath, payload as string, 'utf8');
      }

      const index = readIndex(basePath);
      index.set(id, metaToIndexEntry(meta));
      writeIndex(basePath, index);

      return artifact;
    },

    async update(artifactId, patch, changelog) {
      const meta = readMeta(basePath, artifactId);
      if (!meta) throw new Error(`Artifact not found: ${artifactId}`);
      const now = new Date().toISOString();
      const nextVersion = meta.version + 1;
      const newData = patch.data !== undefined ? patch.data : readVersionData(basePath, artifactId, meta.version, meta.dataKind);
      const { kind, payload } = serializeData(newData);
      const sizeBytes = patch.data !== undefined ? estimateSize(newData) : meta.sizeBytes;

      const updatedMeta: MetaFile = {
        ...meta,
        name: patch.name ?? meta.name,
        type: patch.type ?? meta.type,
        mimeType: patch.mimeType ?? meta.mimeType,
        sizeBytes,
        version: nextVersion,
        sessionId: patch.sessionId ?? meta.sessionId,
        userId: patch.userId ?? meta.userId,
        agentId: patch.agentId ?? meta.agentId,
        runId: patch.runId ?? meta.runId,
        tags: patch.tags ?? meta.tags,
        metadata: patch.metadata ?? meta.metadata,
        scope: patch.scope ?? meta.scope,
        updatedAt: now,
        dataKind: kind,
      };

      const updated: Artifact = {
        id: meta.id,
        name: updatedMeta.name,
        type: updatedMeta.type as ArtifactType,
        mimeType: updatedMeta.mimeType,
        data: newData,
        sizeBytes,
        version: nextVersion,
        sessionId: updatedMeta.sessionId,
        userId: updatedMeta.userId,
        agentId: updatedMeta.agentId,
        runId: updatedMeta.runId,
        tags: updatedMeta.tags,
        metadata: updatedMeta.metadata,
        scope: (updatedMeta.scope as ArtifactScope) ?? 'session',
        createdAt: meta.createdAt,
        updatedAt: now,
      };
      enforcePolicy(updated);

      writeMeta(basePath, updatedMeta);
      const vPath = versionPath(basePath, artifactId, nextVersion, kind);
      if (kind === 'binary') {
        fs.writeFileSync(vPath, payload as Buffer);
      } else {
        fs.writeFileSync(vPath, payload as string, 'utf8');
      }

      // Write changelog sidecar alongside the version file
      if (changelog) {
        const changelogPath = vPath.replace(/\.(dat|txt)$/, '.changelog.txt');
        fs.writeFileSync(changelogPath, changelog, 'utf8');
      }

      const index = readIndex(basePath);
      index.set(artifactId, metaToIndexEntry(updatedMeta));
      writeIndex(basePath, index);

      return updated;
    },

    async get(artifactId) {
      const meta = readMeta(basePath, artifactId);
      if (!meta) return null;
      return metaToArtifact(meta, basePath);
    },

    async list(filter?: ArtifactListFilter) {
      const index = readIndex(basePath);
      let entries = [...index.values()];

      if (filter) {
        entries = entries.filter((e) => indexEntryMatchesFilter(e, filter));
      }

      // Sort descending by createdAt
      entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      if (filter?.offset) entries = entries.slice(filter.offset);
      if (filter?.limit) entries = entries.slice(0, filter.limit);

      // Inflate each entry to a full Artifact (reads version data from disk)
      return entries.map((e) => {
        const meta = readMeta(basePath, e.id);
        if (!meta) return null;
        return metaToArtifact(meta, basePath);
      }).filter((a): a is Artifact => a !== null);
    },

    async delete(artifactId) {
      const dir = artifactDir(basePath, artifactId);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      const index = readIndex(basePath);
      index.delete(artifactId);
      writeIndex(basePath, index);
    },

    async getVersions(artifactId) {
      const meta = readMeta(basePath, artifactId);
      if (!meta) return [];
      const versions: ArtifactVersion[] = [];
      for (let v = 1; v <= meta.version; v++) {
        const textPath = versionPath(basePath, artifactId, v, 'text');
        const binPath = versionPath(basePath, artifactId, v, 'binary');
        let kind: 'text' | 'binary' = 'text';
        if (!fs.existsSync(textPath)) {
          if (fs.existsSync(binPath)) kind = 'binary';
          else continue;
        }
        const data = readVersionData(basePath, artifactId, v, kind);
        const changelogPath = versionPath(basePath, artifactId, v, kind).replace(/\.(dat|txt)$/, '.changelog.txt');
        let changelog: string | undefined;
        if (fs.existsSync(changelogPath)) {
          try { changelog = fs.readFileSync(changelogPath, 'utf8'); } catch { /* ignore */ }
        }
        const verId = `${artifactId}-v${v}`;
        versions.push({
          id: verId,
          artifactId,
          version: v,
          data,
          changelog,
          createdAt: meta.createdAt,
        });
      }
      return versions;
    },
  };
}
