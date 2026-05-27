/**
 * @weaveintel/workflows — StepLockStore
 *
 * Phase W4 — Exactly-once step execution.
 *
 * Before a step handler is invoked the engine writes a `locked` record.
 * After the handler succeeds and the checkpoint is saved the engine
 * upgrades the record to `done` and stores the output.
 *
 * On recovery after a process crash:
 *  - If `isDone` → replay the cached output, skip handler re-execution.
 *  - If `isLocked` (no `done`) → the process crashed mid-execution; re-run.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { newUUIDv7 } from '@weaveintel/core';

export interface StepLockEntry {
  runId: string;
  stepId: string;
  state: 'locked' | 'done';
  lockedAt: string;
  doneAt?: string;
  output?: unknown;
}

export interface StepLockStore {
  /** Write a `locked` record before handler execution. */
  lock(runId: string, stepId: string): Promise<void>;
  /** Upgrade the record to `done` and store the step output. */
  markDone(runId: string, stepId: string, output: unknown): Promise<void>;
  /** True if a `done` record exists — output can be replayed. */
  isDone(runId: string, stepId: string): Promise<{ done: boolean; output?: unknown }>;
  /** True if a `locked` record exists (regardless of done status). */
  isLocked(runId: string, stepId: string): Promise<boolean>;
  /** Remove all lock records for a run (called after run completes/fails). */
  clear(runId: string): Promise<void>;
}

function key(runId: string, stepId: string): string {
  return `${runId}:${stepId}`;
}

function now(): string {
  return new Date().toISOString();
}

// ─── In-memory ─────────────────────────────────────────────────────────────

export class InMemoryStepLockStore implements StepLockStore {
  private readonly store = new Map<string, StepLockEntry>();

  async lock(runId: string, stepId: string): Promise<void> {
    const k = key(runId, stepId);
    if (!this.store.has(k)) {
      this.store.set(k, { runId, stepId, state: 'locked', lockedAt: now() });
    }
  }

  async markDone(runId: string, stepId: string, output: unknown): Promise<void> {
    const k = key(runId, stepId);
    const existing = this.store.get(k);
    this.store.set(k, {
      runId, stepId,
      state: 'done',
      lockedAt: existing?.lockedAt ?? now(),
      doneAt: now(),
      output,
    });
  }

  async isDone(runId: string, stepId: string): Promise<{ done: boolean; output?: unknown }> {
    const entry = this.store.get(key(runId, stepId));
    if (entry?.state === 'done') return { done: true, output: entry.output };
    return { done: false };
  }

  async isLocked(runId: string, stepId: string): Promise<boolean> {
    return this.store.has(key(runId, stepId));
  }

  async clear(runId: string): Promise<void> {
    for (const k of this.store.keys()) {
      if (k.startsWith(`${runId}:`)) this.store.delete(k);
    }
  }

  get size(): number { return this.store.size; }
}

// ─── JSON-file-backed ──────────────────────────────────────────────────────

export class JsonFileStepLockStore implements StepLockStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private runDir(runId: string): string {
    return join(this.baseDir, 'step-locks', runId);
  }

  private filePath(runId: string, stepId: string): string {
    return join(this.runDir(runId), `${stepId}.json`);
  }

  async lock(runId: string, stepId: string): Promise<void> {
    const fp = this.filePath(runId, stepId);
    try {
      await readFile(fp, 'utf8');
      return; // already exists
    } catch {
      // does not exist
    }
    await mkdir(this.runDir(runId), { recursive: true });
    const entry: StepLockEntry = {
      runId, stepId, state: 'locked', lockedAt: now(),
      // stale id for cross-store dedup
    };
    await writeFile(fp, JSON.stringify(entry), 'utf8');
  }

  async markDone(runId: string, stepId: string, output: unknown): Promise<void> {
    let existing: StepLockEntry | undefined;
    try {
      existing = JSON.parse(await readFile(this.filePath(runId, stepId), 'utf8')) as StepLockEntry;
    } catch { /* not found */ }
    await mkdir(this.runDir(runId), { recursive: true });
    const entry: StepLockEntry = {
      runId, stepId,
      state: 'done',
      lockedAt: existing?.lockedAt ?? now(),
      doneAt: now(),
      output,
    };
    await writeFile(this.filePath(runId, stepId), JSON.stringify(entry), 'utf8');
  }

  async isDone(runId: string, stepId: string): Promise<{ done: boolean; output?: unknown }> {
    try {
      const entry = JSON.parse(await readFile(this.filePath(runId, stepId), 'utf8')) as StepLockEntry;
      if (entry.state === 'done') return { done: true, output: entry.output };
    } catch { /* not found */ }
    return { done: false };
  }

  async isLocked(runId: string, stepId: string): Promise<boolean> {
    try {
      await readFile(this.filePath(runId, stepId), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  async clear(runId: string): Promise<void> {
    const { rm } = await import('node:fs/promises');
    await rm(this.runDir(runId), { recursive: true, force: true });
  }
}

export const STEP_LOCK_STORE_KEY = '__stepLock' as const;

/** Generate a unique step lock ID. */
export function newStepLockId(): string {
  return newUUIDv7();
}
