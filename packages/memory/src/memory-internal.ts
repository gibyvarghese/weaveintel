/**
 * Internal helpers shared across all memory store backends.
 * Not exported from the package public API.
 */

import type {
  MemoryEntry,
  MemoryType,
  MemoryStore,
  MemoryQuery,
  MemoryFilter,
  ExecutionContext,
} from '@weaveintel/core';

export type { MemoryType };

export type DurableMemoryStore = MemoryStore & { close(): Promise<void> };

export interface StoredMemoryDocument {
  _id: string;
  type: MemoryType;
  content: string;
  metadata: Record<string, unknown>;
  embedding?: readonly number[];
  createdAt: string;
  expiresAt?: string;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  updatedAt: Date;
}

export function matchesFilter(entry: MemoryEntry, filter?: MemoryFilter): boolean {
  if (!filter) return true;
  if (filter.tenantId && entry.tenantId !== filter.tenantId) return false;
  if (filter.userId && entry.userId !== filter.userId) return false;
  if (filter.sessionId && entry.sessionId !== filter.sessionId) return false;
  if (filter.types && !filter.types.includes(entry.type)) return false;
  if (filter.after && entry.createdAt < filter.after) return false;
  if (filter.before && entry.createdAt > filter.before) return false;
  return true;
}

export function applyMemoryQuery(entries: MemoryEntry[], options: MemoryQuery): MemoryEntry[] {
  let results = [...entries];
  if (options.type) {
    results = results.filter((entry) => entry.type === options.type);
  }
  results = results.filter((entry) => matchesFilter(entry, options.filter));

  // Bi-temporal asOf filter: exclude entries invalidated before asOf
  if (options.asOf) {
    const asOfTs = new Date(options.asOf).getTime();
    results = results.filter((entry) => {
      const validAt = entry.validAt ? new Date(entry.validAt).getTime() : new Date(entry.createdAt).getTime();
      if (validAt > asOfTs) return false;
      if (entry.invalidAt && new Date(entry.invalidAt).getTime() <= asOfTs) return false;
      return true;
    });
  } else {
    // Default: filter out currently-invalid entries
    results = results.filter((entry) => !entry.invalidAt);
  }

  if (options.embedding) {
    const queryEmb = options.embedding;
    results = results
      .filter((entry) => entry.embedding)
      .map((entry) => ({ entry, score: cosineSimilarity(queryEmb, entry.embedding!) }))
      .filter((row) => !options.minScore || row.score >= options.minScore)
      .sort((left, right) => right.score - left.score)
      .slice(0, options.topK ?? 10)
      .map((row) => ({ ...row.entry, score: row.score }));
    return results;
  }

  if (options.query) {
    const lower = options.query.toLowerCase();
    results = results.filter((entry) => entry.content.toLowerCase().includes(lower));
  }

  return results.slice(0, options.topK ?? 10);
}

/** Heuristic importance score (0–1) for an entry at write time. */
export function computeImportance(entry: MemoryEntry): number {
  if (entry.importance !== undefined) return entry.importance;
  let score = 0.4;
  const words = entry.content.trim().split(/\s+/).length;
  if (words >= 5 && words <= 60) score += 0.15;
  if (entry.type === 'semantic' || entry.type === 'procedural') score += 0.2;
  if (entry.type === 'episodic') score += 0.05;
  const src = entry.metadata['source'] as string | undefined;
  if (src === 'user') score += 0.15;
  if (/[A-Z][a-z]/.test(entry.content)) score += 0.05;
  if (/\d/.test(entry.content)) score += 0.05;
  return Math.min(1.0, Math.max(0.0, score));
}

export function parseStoredMemoryRow(value: string): MemoryEntry {
  return JSON.parse(value) as MemoryEntry;
}

export function sessionScopeFromContext(ctx: ExecutionContext): string {
  const scopedSessionId = ctx.metadata['sessionId'];
  if (typeof scopedSessionId === 'string' && scopedSessionId.length > 0) {
    return scopedSessionId;
  }
  return ctx.executionId;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
