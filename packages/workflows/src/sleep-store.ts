/**
 * @weaveintel/workflows — DurableSleepStore + DurableSleepScheduler
 *
 * Phase W4 — Durable sleep for `wait` steps.
 *
 * When a `wait` step carries `step.wakeAfterMs`, the engine calls
 * `sleepStore.schedule(runId, Date.now() + step.wakeAfterMs)` instead of
 * waiting for an external `resumeRun()`.  The scheduler polls for due records
 * and calls `engine.resumeRun(runId)` automatically.  Because the record is
 * persisted, the sleep survives process restarts.
 */

import type { SleepRecord, DurableSleepStore } from '@weaveintel/core';
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';

function nowIso(): string { return new Date().toISOString(); }

// ─── In-memory ─────────────────────────────────────────────────────────────

export class InMemorySleepStore implements DurableSleepStore {
  private readonly records = new Map<string, SleepRecord>();

  async schedule(runId: string, wakeAt: number): Promise<void> {
    this.records.set(runId, { runId, wakeAt, createdAt: nowIso() });
  }

  async cancel(runId: string): Promise<void> {
    this.records.delete(runId);
  }

  async getDue(now = Date.now()): Promise<SleepRecord[]> {
    return [...this.records.values()].filter(r => r.wakeAt <= now);
  }

  async list(): Promise<SleepRecord[]> {
    return [...this.records.values()];
  }

  get size(): number { return this.records.size; }
}

// ─── JSON-file-backed ──────────────────────────────────────────────────────

export class JsonFileSleepStore implements DurableSleepStore {
  private readonly dir: string;

  constructor(baseDir: string) {
    this.dir = join(baseDir, 'sleeps');
  }

  private filePath(runId: string): string {
    return join(this.dir, `${runId}.json`);
  }

  async schedule(runId: string, wakeAt: number): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const record: SleepRecord = { runId, wakeAt, createdAt: nowIso() };
    await writeFile(this.filePath(runId), JSON.stringify(record), 'utf8');
  }

  async cancel(runId: string): Promise<void> {
    await rm(this.filePath(runId), { force: true });
  }

  async getDue(now = Date.now()): Promise<SleepRecord[]> {
    const all = await this.list();
    return all.filter(r => r.wakeAt <= now);
  }

  async list(): Promise<SleepRecord[]> {
    try {
      const files = await readdir(this.dir);
      const results: SleepRecord[] = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const raw = JSON.parse(await readFile(join(this.dir, f), 'utf8')) as SleepRecord;
          results.push(raw);
        } catch { /* skip corrupt */ }
      }
      return results;
    } catch {
      return [];
    }
  }
}

// ─── Scheduler ─────────────────────────────────────────────────────────────

export interface SleepResumeTarget {
  resumeRun(runId: string, data?: unknown): Promise<unknown>;
}

/**
 * Polls `DurableSleepStore.getDue()` on an interval and calls
 * `engine.resumeRun(runId)` for each record whose `wakeAt` has passed.
 *
 * Usage:
 *   const scheduler = new DurableSleepScheduler(sleepStore, engine);
 *   scheduler.start();          // begin polling (default 1 s interval)
 *   await scheduler.tick();     // single manual tick (useful in tests)
 *   scheduler.stop();
 */
export class DurableSleepScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: DurableSleepStore,
    private readonly engine: SleepResumeTarget,
  ) {}

  /** Start background polling at `intervalMs` (default 1000 ms). */
  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Allow process to exit even if the scheduler is still running
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as { unref(): void }).unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Process all due sleep records once.
   * Returns the number of runs resumed.
   */
  async tick(): Promise<number> {
    const due = await this.store.getDue();
    let resumed = 0;
    for (const record of due) {
      try {
        await this.store.cancel(record.runId);
        await this.engine.resumeRun(record.runId, { __sleepExpired: true, wakeAt: record.wakeAt });
        resumed++;
      } catch {
        // Best-effort: run may have been cancelled or already resumed externally.
        // cancel() already removed the record so we won't retry infinitely.
      }
    }
    return resumed;
  }
}
