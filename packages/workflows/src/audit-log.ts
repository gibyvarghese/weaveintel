/**
 * @weaveintel/workflows — WorkflowAuditLog
 *
 * Phase W4 — Immutable append-only audit trail.
 *
 * Every engine state transition (step started/completed/failed, run started/
 * completed/failed/paused, durable-sleep scheduled/resumed, child-run cancelled)
 * is appended here.  Consumers can call `list(runId)` to reconstruct the full
 * causal history of any run.
 */

import type { WorkflowAuditEvent, WorkflowAuditLog } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import { readFile, writeFile, mkdir, readdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

function newId(): string { return newUUIDv7(); }

// ─── In-memory ─────────────────────────────────────────────────────────────

export class InMemoryAuditLog implements WorkflowAuditLog {
  private readonly events: WorkflowAuditEvent[] = [];

  async append(event: Omit<WorkflowAuditEvent, 'id'>): Promise<void> {
    this.events.push({ id: newId(), ...event });
  }

  async list(runId: string): Promise<WorkflowAuditEvent[]> {
    return this.events.filter(e => e.runId === runId);
  }

  async listAll(opts?: { workflowId?: string; limit?: number }): Promise<WorkflowAuditEvent[]> {
    let result = this.events;
    if (opts?.workflowId) result = result.filter(e => e.workflowId === opts.workflowId);
    if (opts?.limit) result = result.slice(-opts.limit);
    return result;
  }

  get size(): number { return this.events.length; }
}

// ─── NDJSON-file-backed ────────────────────────────────────────────────────
//
// One NDJSON file per run: <baseDir>/audit/<runId>.ndjson
// Appending is atomic enough for single-process use.

export class JsonFileAuditLog implements WorkflowAuditLog {
  private readonly dir: string;

  constructor(baseDir: string) {
    this.dir = join(baseDir, 'audit');
  }

  private runFile(runId: string): string {
    return join(this.dir, `${runId}.ndjson`);
  }

  async append(event: Omit<WorkflowAuditEvent, 'id'>): Promise<void> {
    const full: WorkflowAuditEvent = { id: newId(), ...event };
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.runFile(full.runId), JSON.stringify(full) + '\n', 'utf8');
  }

  async list(runId: string): Promise<WorkflowAuditEvent[]> {
    try {
      const raw = await readFile(this.runFile(runId), 'utf8');
      return raw
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as WorkflowAuditEvent);
    } catch {
      return [];
    }
  }

  async listAll(opts?: { workflowId?: string; limit?: number }): Promise<WorkflowAuditEvent[]> {
    const results: WorkflowAuditEvent[] = [];
    try {
      const files = await readdir(this.dir);
      for (const f of files) {
        if (!f.endsWith('.ndjson')) continue;
        try {
          const raw = await readFile(join(this.dir, f), 'utf8');
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try {
              const ev = JSON.parse(line) as WorkflowAuditEvent;
              if (!opts?.workflowId || ev.workflowId === opts.workflowId) {
                results.push(ev);
              }
            } catch { /* skip corrupt */ }
          }
        } catch { /* skip unreadable */ }
      }
    } catch { /* dir not yet created */ }
    // Sort ascending by timestamp
    results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return opts?.limit ? results.slice(-opts.limit) : results;
  }
}

/** Convenience builder so the engine can construct an audit event in one line. */
export function makeAuditEvent(
  base: Pick<WorkflowAuditEvent, 'runId' | 'workflowId' | 'type'> &
    Partial<Omit<WorkflowAuditEvent, 'id' | 'runId' | 'workflowId' | 'type'>>,
): Omit<WorkflowAuditEvent, 'id'> {
  return {
    timestamp: new Date().toISOString(),
    ...base,
  };
}
