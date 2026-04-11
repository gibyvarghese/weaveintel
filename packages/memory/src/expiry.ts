/**
 * @weaveintel/memory — Expiry and forgetting
 *
 * Enforces retention policies by expiring old entries, compacting
 * memory stores, and supporting explicit "right to be forgotten".
 */

import type { MemoryEntry, MemoryStore, MemoryRetentionPolicy, ExecutionContext } from '@weaveintel/core';

/** Check if a memory entry has expired based on its expiresAt field. */
export function isExpired(entry: MemoryEntry): boolean {
  if (!entry.expiresAt) return false;
  return new Date(entry.expiresAt).getTime() < Date.now();
}

/** Filter out expired entries from a list. */
export function filterExpired(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.filter((e) => !isExpired(e));
}

/** Enforce retention policy on a list of entries (returns entries to keep). */
export function enforceRetention(
  entries: MemoryEntry[],
  policy: MemoryRetentionPolicy,
): { keep: MemoryEntry[]; drop: MemoryEntry[] } {
  let candidates = [...entries];
  const drop: MemoryEntry[] = [];

  // Remove expired
  for (const entry of candidates) {
    if (isExpired(entry)) {
      drop.push(entry);
    }
  }
  candidates = candidates.filter((e) => !isExpired(e));

  // Enforce maxAge
  if (policy.maxAge) {
    const maxAgeMs = parseIsoDuration(policy.maxAge);
    if (maxAgeMs > 0) {
      const cutoff = Date.now() - maxAgeMs;
      for (const entry of candidates) {
        if (new Date(entry.createdAt).getTime() < cutoff) {
          drop.push(entry);
        }
      }
      candidates = candidates.filter((e) => new Date(e.createdAt).getTime() >= (Date.now() - maxAgeMs));
    }
  }

  // Enforce maxEntries with compaction strategy
  if (policy.maxEntries && candidates.length > policy.maxEntries) {
    const sorted = sortByStrategy(candidates, policy.compactionStrategy ?? 'drop_oldest');
    const excess = sorted.slice(policy.maxEntries);
    drop.push(...excess);
    candidates = sorted.slice(0, policy.maxEntries);
  }

  return { keep: candidates, drop };
}

/** Delete all entries for a specific user (right to be forgotten). */
export async function forgetUser(
  store: MemoryStore,
  ctx: ExecutionContext,
  userId: string,
): Promise<void> {
  await store.clear(ctx, { userId });
}

/** Delete all entries for a specific session. */
export async function forgetSession(
  store: MemoryStore,
  ctx: ExecutionContext,
  sessionId: string,
): Promise<void> {
  await store.clear(ctx, { sessionId });
}

// ── Helpers ──────────────────────────────────────────────────

function sortByStrategy(
  entries: MemoryEntry[],
  strategy: string,
): MemoryEntry[] {
  switch (strategy) {
    case 'drop_lowest_score':
      return [...entries].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    case 'summarize':
    case 'drop_oldest':
    default:
      return [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

/** Parse a subset of ISO 8601 durations into milliseconds. */
function parseIsoDuration(duration: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration);
  if (!match) return 0;
  const days = parseInt(match[1] ?? '0', 10);
  const hours = parseInt(match[2] ?? '0', 10);
  const minutes = parseInt(match[3] ?? '0', 10);
  const seconds = parseInt(match[4] ?? '0', 10);
  return ((days * 24 + hours) * 60 + minutes) * 60000 + seconds * 1000;
}
