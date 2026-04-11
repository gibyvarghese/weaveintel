/**
 * @weaveintel/memory — Provenance tracking
 *
 * Tracks the origin and confidence of memory entries so that
 * downstream consumers can trust or weight memories appropriately.
 */

import type { MemoryEntry } from '@weaveintel/core';

export interface ProvenanceInfo {
  source: string;          // e.g. 'user-input', 'llm-extraction', 'tool-result'
  confidence: number;      // 0 – 1
  extractedBy?: string;    // agent or model that produced it
  verifiedBy?: string;     // human or agent that verified it
  createdAt: string;
}

const provenanceMap = new Map<string, ProvenanceInfo>();

/** Attach provenance to a memory entry. */
export function setProvenance(entryId: string, info: ProvenanceInfo): void {
  provenanceMap.set(entryId, info);
}

/** Get provenance for a memory entry. */
export function getProvenance(entryId: string): ProvenanceInfo | undefined {
  return provenanceMap.get(entryId);
}

/** Stamp provenance metadata onto a MemoryEntry. */
export function withProvenance(entry: MemoryEntry, info: ProvenanceInfo): MemoryEntry {
  setProvenance(entry.id, info);
  return {
    ...entry,
    metadata: {
      ...entry.metadata,
      _provenance: info,
    },
  };
}

/** Filter entries that meet a minimum confidence threshold. */
export function filterByConfidence(entries: MemoryEntry[], minConfidence: number): MemoryEntry[] {
  return entries.filter((e) => {
    const prov = (e.metadata['_provenance'] as ProvenanceInfo | undefined) ?? getProvenance(e.id);
    return prov ? prov.confidence >= minConfidence : true; // allow entries without provenance
  });
}
