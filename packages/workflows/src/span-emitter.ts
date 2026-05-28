/**
 * @weaveintel/workflows — span-emitter.ts
 *
 * Phase W6 — Structured step spans for observability.
 *
 * Each step execution emits a `WorkflowSpan` with timing, handler kind,
 * retry count, and cost. Backends: in-memory (tests), console (dev), JSON
 * file (local durable), and DB (production — lives in geneweave).
 */

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowSpan, WorkflowSpanEmitter } from '@weaveintel/core';

export type { WorkflowSpan, WorkflowSpanEmitter };

// ─── In-memory ─────────────────────────────────────────────────────────────

export class InMemorySpanEmitter implements WorkflowSpanEmitter {
  private readonly spans: WorkflowSpan[] = [];

  emit(span: WorkflowSpan): void {
    this.spans.push({ ...span });
  }

  async getSpans(runId: string): Promise<WorkflowSpan[]> {
    return this.spans.filter(s => s.runId === runId);
  }

  async getAllSpans(): Promise<WorkflowSpan[]> {
    return [...this.spans];
  }

  async clear(runId: string): Promise<void> {
    const toRemove = new Set(this.spans.filter(s => s.runId === runId).map((_, i) => i));
    for (let i = this.spans.length - 1; i >= 0; i--) {
      if (this.spans[i]?.runId === runId) this.spans.splice(i, 1);
    }
    void toRemove;
  }
}

// ─── Console (dev) ─────────────────────────────────────────────────────────

export class ConsoleSpanEmitter implements WorkflowSpanEmitter {
  private readonly inner = new InMemorySpanEmitter();

  emit(span: WorkflowSpan): void {
    this.inner.emit(span);
    const costStr = span.costUsd > 0 ? ` cost=$${span.costUsd.toFixed(4)}` : '';
    const retryStr = span.retryCount > 0 ? ` retries=${span.retryCount}` : '';
    const errStr = span.error ? ` err=${span.error.slice(0, 60)}` : '';
    console.log(
      `[span] ${span.stepId} ${span.status} ${span.durationMs}ms` +
      ` kind=${span.handlerKind} handler=${span.handlerKey}` +
      costStr + retryStr + errStr,
    );
  }

  async getSpans(runId: string): Promise<WorkflowSpan[]> {
    return this.inner.getSpans(runId);
  }

  async getAllSpans(): Promise<WorkflowSpan[]> {
    return this.inner.getAllSpans();
  }

  async clear(runId: string): Promise<void> {
    return this.inner.clear(runId);
  }
}

// ─── JSON-file-backed (NDJSON per run) ────────────────────────────────────

/**
 * Writes spans to `<baseDir>/spans/<runId>.ndjson`.
 * Each line is one JSON-serialised WorkflowSpan.
 * Reads are O(n) line-scan; suitable for dev and local tracing.
 */
export class JsonFileSpanEmitter implements WorkflowSpanEmitter {
  constructor(private readonly baseDir: string) {}

  private spanDir(): string {
    return join(this.baseDir, 'spans');
  }

  private filePath(runId: string): string {
    return join(this.spanDir(), `${runId}.ndjson`);
  }

  async emit(span: WorkflowSpan): Promise<void> {
    await mkdir(this.spanDir(), { recursive: true });
    await appendFile(this.filePath(span.runId), JSON.stringify(span) + '\n', 'utf8');
  }

  async getSpans(runId: string): Promise<WorkflowSpan[]> {
    try {
      const raw = await readFile(this.filePath(runId), 'utf8');
      return raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as WorkflowSpan);
    } catch {
      return [];
    }
  }

  async getAllSpans(): Promise<WorkflowSpan[]> {
    const { readdir } = await import('node:fs/promises');
    try {
      const files = await readdir(this.spanDir());
      const all: WorkflowSpan[] = [];
      for (const f of files.filter(f => f.endsWith('.ndjson'))) {
        try {
          const raw = await readFile(join(this.spanDir(), f), 'utf8');
          all.push(...raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as WorkflowSpan));
        } catch { /* skip corrupt file */ }
      }
      return all;
    } catch {
      return [];
    }
  }

  async clear(runId: string): Promise<void> {
    const { unlink } = await import('node:fs/promises');
    try { await unlink(this.filePath(runId)); } catch { /* already gone */ }
  }
}
