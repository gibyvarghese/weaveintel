/**
 * @weaveintel/memory — Deduplication
 *
 * Detects and removes duplicate memory entries based on content
 * similarity or exact match, keeping the most recent or highest-scored.
 */

import type { MemoryEntry } from '@weaveintel/core';

/** Strategy for keeping entries when duplicates are found. */
export type DeduplicationStrategy = 'keep_newest' | 'keep_highest_score' | 'merge';

/** Deduplicate memory entries by exact content match. */
export function deduplicateExact(
  entries: MemoryEntry[],
  strategy: DeduplicationStrategy = 'keep_newest',
): MemoryEntry[] {
  const groups = new Map<string, MemoryEntry[]>();

  for (const entry of entries) {
    const key = entry.content.trim().toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  const result: MemoryEntry[] = [];
  for (const group of groups.values()) {
    result.push(pickWinner(group, strategy));
  }
  return result;
}

/** Deduplicate by a custom key function. */
export function deduplicateByKey(
  entries: MemoryEntry[],
  keyFn: (e: MemoryEntry) => string,
  strategy: DeduplicationStrategy = 'keep_newest',
): MemoryEntry[] {
  const groups = new Map<string, MemoryEntry[]>();

  for (const entry of entries) {
    const key = keyFn(entry);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  const result: MemoryEntry[] = [];
  for (const group of groups.values()) {
    result.push(pickWinner(group, strategy));
  }
  return result;
}

function pickWinner(group: MemoryEntry[], strategy: DeduplicationStrategy): MemoryEntry {
  if (group.length === 1) return group[0]!;

  switch (strategy) {
    case 'keep_highest_score':
      return group.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]!;
    case 'merge': {
      // Merge metadata from all entries into the newest
      const sorted = group.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const merged = { ...sorted[0]! };
      for (let i = 1; i < sorted.length; i++) {
        Object.assign(merged.metadata, sorted[i]!.metadata);
      }
      return merged;
    }
    case 'keep_newest':
    default:
      return group.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
  }
}
