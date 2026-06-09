/**
 * @weaveintel/memory — Correction workflows
 *
 * Supports correcting, superseding, and annotating existing memory entries
 * while preserving the original for audit purposes.
 *
 * Bi-temporal supersession: instead of overwriting contradicting facts,
 * `supersede()` sets `invalidAt` on the old entry so the full fact history
 * is queryable via `MemoryQuery.asOf`.
 */

import type { MemoryEntry, MemoryStore, ExecutionContext } from '@weaveintel/core';

/** A correction record linking new content to the original entry. */
export interface Correction {
  originalId: string;
  correctedContent: string;
  reason: string;
  correctedBy: string;
  correctedAt: string;
}

const corrections = new Map<string, Correction[]>();

/** Record a correction for a memory entry. */
export function recordCorrection(correction: Correction): void {
  const list = corrections.get(correction.originalId) ?? [];
  list.push(correction);
  corrections.set(correction.originalId, list);
}

/** Get all corrections for a memory entry. */
export function getCorrections(entryId: string): Correction[] {
  return corrections.get(entryId) ?? [];
}

/**
 * Apply a correction to a memory entry in the store: writes a new corrected
 * entry and marks the old one with _supersededBy metadata.
 */
export async function applyCorrection(
  store: MemoryStore,
  ctx: ExecutionContext,
  original: MemoryEntry,
  correctedContent: string,
  correctedBy: string,
  reason: string,
): Promise<MemoryEntry> {
  const now = new Date().toISOString();
  const correctedEntry: MemoryEntry = {
    ...original,
    id: `${original.id}_corrected_${Date.now()}`,
    content: correctedContent,
    metadata: {
      ...original.metadata,
      _correctedFrom: original.id,
      _correctedBy: correctedBy,
      _correctionReason: reason,
    },
    createdAt: now,
  };

  // Mark original as superseded
  const superseded: MemoryEntry = {
    ...original,
    metadata: {
      ...original.metadata,
      _supersededBy: correctedEntry.id,
      _supersededAt: now,
    },
  };

  await store.write(ctx, [superseded, correctedEntry]);

  recordCorrection({
    originalId: original.id,
    correctedContent,
    reason,
    correctedBy,
    correctedAt: now,
  });

  return correctedEntry;
}

/**
 * Bi-temporal supersession: a contradicting fact invalidates the old entry
 * (sets `invalidAt`) rather than overwriting it. Both versions remain in the
 * store and are queryable via `MemoryQuery.asOf`.
 *
 * Use `applyCorrection` when you want to fix an error (audit trail only).
 * Use `supersede` when the world changed and the old fact was previously true.
 */
export async function supersede(
  store: MemoryStore,
  ctx: ExecutionContext,
  original: MemoryEntry,
  newContent: string,
  supersededBy: string,
  reason?: string,
): Promise<MemoryEntry> {
  const now = new Date().toISOString();

  // Close out the old entry by setting invalidAt
  const invalidated: MemoryEntry = {
    ...original,
    invalidAt: now,
    metadata: {
      ...original.metadata,
      _supersededBy: `${original.id}_successor_${Date.now()}`,
      _supersededAt: now,
      _supersessionReason: reason ?? 'fact superseded',
    },
  };

  const successor: MemoryEntry = {
    ...original,
    id: `${original.id}_successor_${Date.now()}`,
    content: newContent,
    createdAt: now,
    validAt: now,
    invalidAt: undefined,
    metadata: {
      ...original.metadata,
      _supersedes: original.id,
      _supersededBy: supersededBy,
      _supersessionReason: reason ?? 'fact superseded',
    },
  };

  await store.write(ctx, [invalidated, successor]);

  recordCorrection({
    originalId: original.id,
    correctedContent: newContent,
    reason: reason ?? 'bi-temporal supersession',
    correctedBy: supersededBy,
    correctedAt: now,
  });

  return successor;
}
