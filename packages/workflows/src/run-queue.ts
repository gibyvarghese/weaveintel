/**
 * @weaveintel/workflows — WorkflowRunQueue
 *
 * Phase W5 — Priority queue for runs buffered by the concurrency limiter.
 *
 * When `policy.maxConcurrentRuns` is reached and a `runQueue` is configured
 * on the engine, incoming runs are not rejected — they are enqueued with
 * priority `0–9` (higher = higher priority) and started as capacity frees.
 *
 * Each `RunQueueEntry` holds the run's ID (the `WorkflowRun` row was already
 * saved to the repository with `status: 'pending'`), the workflowId, and the
 * start parameters needed to resume execution when dequeued.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { newUUIDv7 } from '@weaveintel/core';

export interface RunQueueEntry {
  /** Unique queue entry ID. */
  id: string;
  /** The WorkflowRun.id for the pending run (already saved to repository). */
  runId: string;
  workflowId: string;
  /** Input variables passed to startRun (needed to build initial state on dequeue). */
  input: Record<string, unknown>;
  /** Priority: 0–9, higher = started first. */
  priority: number;
  queuedAt: string;   // ISO-8601
  /** Original start opts (traceId, tenantId, parentRunId) to restore on dequeue. */
  opts: { traceId?: string; tenantId?: string; parentRunId?: string };
}

export interface WorkflowRunQueue {
  /**
   * Add a run to the queue. Higher priority entries are dequeued first;
   * ties are broken by `queuedAt` (FIFO within the same priority).
   */
  enqueue(entry: Omit<RunQueueEntry, 'id' | 'queuedAt'>): Promise<RunQueueEntry>;
  /**
   * Remove and return the highest-priority pending entry for the given
   * workflowId, or null if the queue is empty for that workflow.
   */
  dequeue(workflowId: string): Promise<RunQueueEntry | null>;
  /** Remove a specific entry by ID (e.g. when a queued run is cancelled). */
  remove(entryId: string): Promise<void>;
  /** Total pending entries across all workflows. */
  size(): Promise<number>;
  /** Pending entries for a specific workflow. */
  sizeFor(workflowId: string): Promise<number>;
  /** All pending entries for a specific workflow (highest priority first). */
  listFor(workflowId: string): Promise<RunQueueEntry[]>;
  /** All pending entries across all workflows. */
  listAll(): Promise<RunQueueEntry[]>;
}

function sortEntries(entries: RunQueueEntry[]): RunQueueEntry[] {
  return entries.slice().sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.queuedAt.localeCompare(b.queuedAt);
  });
}

// ─── In-memory ─────────────────────────────────────────────────────────────

export class InMemoryRunQueue implements WorkflowRunQueue {
  private readonly entries = new Map<string, RunQueueEntry>();

  async enqueue(entry: Omit<RunQueueEntry, 'id' | 'queuedAt'>): Promise<RunQueueEntry> {
    const full: RunQueueEntry = { id: newUUIDv7(), queuedAt: new Date().toISOString(), ...entry };
    this.entries.set(full.id, full);
    return full;
  }

  async dequeue(workflowId: string): Promise<RunQueueEntry | null> {
    const candidates = sortEntries(
      [...this.entries.values()].filter(e => e.workflowId === workflowId),
    );
    const next = candidates[0];
    if (!next) return null;
    this.entries.delete(next.id);
    return next;
  }

  async remove(entryId: string): Promise<void> {
    this.entries.delete(entryId);
  }

  async size(): Promise<number> {
    return this.entries.size;
  }

  async sizeFor(workflowId: string): Promise<number> {
    return [...this.entries.values()].filter(e => e.workflowId === workflowId).length;
  }

  async listFor(workflowId: string): Promise<RunQueueEntry[]> {
    return sortEntries([...this.entries.values()].filter(e => e.workflowId === workflowId));
  }

  async listAll(): Promise<RunQueueEntry[]> {
    return sortEntries([...this.entries.values()]);
  }
}

// ─── JSON-file-backed ──────────────────────────────────────────────────────

export class JsonFileRunQueue implements WorkflowRunQueue {
  private readonly filePath: string;

  constructor(baseDir: string) {
    this.filePath = join(baseDir, 'run-queue.json');
  }

  private async readAll(): Promise<RunQueueEntry[]> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      return Array.isArray(raw) ? (raw as RunQueueEntry[]) : [];
    } catch {
      return [];
    }
  }

  private async writeAll(entries: RunQueueEntry[]): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, this.filePath);
  }

  async enqueue(entry: Omit<RunQueueEntry, 'id' | 'queuedAt'>): Promise<RunQueueEntry> {
    const full: RunQueueEntry = { id: newUUIDv7(), queuedAt: new Date().toISOString(), ...entry };
    const all = await this.readAll();
    all.push(full);
    await this.writeAll(all);
    return full;
  }

  async dequeue(workflowId: string): Promise<RunQueueEntry | null> {
    const all = await this.readAll();
    const candidates = sortEntries(all.filter(e => e.workflowId === workflowId));
    const next = candidates[0];
    if (!next) return null;
    await this.writeAll(all.filter(e => e.id !== next.id));
    return next;
  }

  async remove(entryId: string): Promise<void> {
    const all = await this.readAll();
    await this.writeAll(all.filter(e => e.id !== entryId));
  }

  async size(): Promise<number> {
    return (await this.readAll()).length;
  }

  async sizeFor(workflowId: string): Promise<number> {
    return (await this.readAll()).filter(e => e.workflowId === workflowId).length;
  }

  async listFor(workflowId: string): Promise<RunQueueEntry[]> {
    return sortEntries((await this.readAll()).filter(e => e.workflowId === workflowId));
  }

  async listAll(): Promise<RunQueueEntry[]> {
    return sortEntries(await this.readAll());
  }
}
