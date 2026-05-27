/**
 * @weaveintel/workflows — payload-store.ts
 *
 * Phase W3 — Large payload offload.
 *
 * When a step output exceeds `policy.maxInlineBytes` (JSON-serialised length),
 * the engine stores the payload externally via a `PayloadStore` and writes a
 * lightweight reference object `{ __payloadRef: key }` into `state.variables`
 * instead.  The full payload can be retrieved at any time via `store.get(key)`.
 *
 * Included implementations:
 *  • `InMemoryPayloadStore`  — Map-backed; great for tests and single-process usage.
 *  • `JsonFilePayloadStore`  — One JSON file per payload, stored in a directory tree.
 */

import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';

/** Sentinel property embedded in variables in place of an offloaded payload. */
export const PAYLOAD_REF_PROP = '__payloadRef';

/** Type-guard for reference objects written to state.variables. */
export function isPayloadRef(value: unknown): value is { __payloadRef: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    PAYLOAD_REF_PROP in (value as object) &&
    typeof (value as Record<string, unknown>)[PAYLOAD_REF_PROP] === 'string'
  );
}

export interface PayloadStore {
  /** Persist `data` under `key`; any existing entry is overwritten. */
  put(key: string, data: unknown): Promise<void>;
  /** Retrieve payload by `key`; returns `undefined` if not found. */
  get(key: string): Promise<unknown | undefined>;
  /** Remove a single payload. */
  delete(key: string): Promise<void>;
  /** Remove all payloads whose key starts with `runId:`. */
  deleteRun(runId: string): Promise<void>;
}

// ─── InMemoryPayloadStore ──────────────────────────────────────────────────

export class InMemoryPayloadStore implements PayloadStore {
  private readonly store = new Map<string, unknown>();

  async put(key: string, data: unknown): Promise<void> {
    this.store.set(key, data);
  }

  async get(key: string): Promise<unknown | undefined> {
    return this.store.has(key) ? this.store.get(key) : undefined;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async deleteRun(runId: string): Promise<void> {
    const prefix = `${runId}:`;
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) this.store.delete(k);
    }
  }

  get size(): number { return this.store.size; }
}

// ─── JsonFilePayloadStore ──────────────────────────────────────────────────

/**
 * File-backed payload store.  Each payload is stored as a single JSON file
 * under `<baseDir>/<runId>/<stepId>.json` (key = `${runId}:${stepId}`).
 * Writes are atomic (tmp-file rename).
 */
export class JsonFilePayloadStore implements PayloadStore {
  constructor(private readonly baseDir: string) {}

  async put(key: string, data: unknown): Promise<void> {
    const filePath = this.keyToPath(key);
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, filePath);
  }

  async get(key: string): Promise<unknown | undefined> {
    const filePath = this.keyToPath(key);
    try {
      const raw = await readFile(filePath, 'utf8');
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.keyToPath(key);
    try { await unlink(filePath); } catch { /* already gone */ }
  }

  async deleteRun(runId: string): Promise<void> {
    const runDir = join(this.baseDir, runId);
    if (!existsSync(runDir)) return;
    const { rm } = await import('node:fs/promises');
    await rm(runDir, { recursive: true, force: true });
  }

  private keyToPath(key: string): string {
    const [runId, ...rest] = key.split(':');
    const stepPart = rest.join(':').replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.baseDir, runId ?? 'unknown', `${stepPart || 'payload'}.json`);
  }
}
