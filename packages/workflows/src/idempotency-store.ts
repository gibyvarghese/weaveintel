/**
 * @weaveintel/workflows — idempotency-store.ts
 *
 * Phase W2 — Idempotency store for step-level exactly-once semantics.
 *
 * A step with `step.idempotencyKey` set will check this store before
 * executing its handler. If a cached output is found under the key
 * `${stepId}:${evaluatedKeyValue}`, the handler is skipped and the cached
 * output is replayed. The cache is populated after each successful handler
 * completion.
 *
 * The key is scoped to `stepId` (not runId) by default, enabling cross-run
 * deduplication — e.g. "don't charge the same orderId twice even if the
 * workflow is retried from the beginning."
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface StepIdempotencyStore {
  /** Return cached output for `key`, or `undefined` if not present. */
  get(key: string): Promise<unknown | undefined>;
  /** Persist the output under `key`. */
  set(key: string, output: unknown): Promise<void>;
  /** Remove a specific entry (e.g. on explicit invalidation). */
  delete(key: string): Promise<void>;
  /** Clear all entries whose key starts with `prefix` (e.g. `stepId:`). */
  clearPrefix(prefix: string): Promise<void>;
}

export class InMemoryIdempotencyStore implements StepIdempotencyStore {
  private readonly store = new Map<string, unknown>();

  async get(key: string): Promise<unknown | undefined> {
    return this.store.has(key) ? this.store.get(key) : undefined;
  }

  async set(key: string, output: unknown): Promise<void> {
    this.store.set(key, output);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clearPrefix(prefix: string): Promise<void> {
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) this.store.delete(k);
    }
  }

  /** Expose raw size for diagnostics / tests. */
  get size(): number { return this.store.size; }
}

/**
 * Durable JSON file-backed idempotency store.
 * All entries are persisted as a flat `{ key: value }` object.
 * Writes are atomic via a tmp-file rename.
 */
export class JsonFileIdempotencyStore implements StepIdempotencyStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async get(key: string): Promise<unknown | undefined> {
    const map = await this.readAll();
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
  }

  async set(key: string, output: unknown): Promise<void> {
    const map = await this.readAll();
    map[key] = output;
    await this.writeAll(map);
  }

  async delete(key: string): Promise<void> {
    const map = await this.readAll();
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      delete map[key];
      await this.writeAll(map);
    }
  }

  async clearPrefix(prefix: string): Promise<void> {
    const map = await this.readAll();
    let changed = false;
    for (const k of Object.keys(map)) {
      if (k.startsWith(prefix)) { delete map[k]; changed = true; }
    }
    if (changed) await this.writeAll(map);
  }

  private async readAll(): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private async writeAll(map: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }
}
