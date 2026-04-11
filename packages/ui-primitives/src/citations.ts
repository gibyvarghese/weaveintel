/**
 * @weaveintel/ui-primitives — Citation payload builder
 */

import { randomUUID } from 'node:crypto';
import type { CitationPayload } from '@weaveintel/core';

export interface CreateCitationOptions {
  text: string;
  source: string;
  url?: string;
  page?: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Build a CitationPayload.
 */
export function createCitation(opts: CreateCitationOptions): CitationPayload {
  return {
    id: randomUUID(),
    text: opts.text,
    source: opts.source,
    url: opts.url,
    page: opts.page,
    confidence: opts.confidence,
    metadata: opts.metadata,
  };
}

/**
 * Convenience: create a citation from a document chunk.
 */
export function documentCitation(
  text: string,
  documentName: string,
  page?: number,
  confidence?: number,
): CitationPayload {
  return createCitation({
    text,
    source: documentName,
    page,
    confidence,
  });
}

/**
 * Convenience: create a citation from a URL source.
 */
export function webCitation(
  text: string,
  url: string,
  sourceName?: string,
  confidence?: number,
): CitationPayload {
  return createCitation({
    text,
    source: sourceName ?? new URL(url).hostname,
    url,
    confidence,
  });
}

/**
 * Collect citations and de-duplicate by source + text combination.
 */
export function deduplicateCitations(citations: CitationPayload[]): CitationPayload[] {
  const seen = new Set<string>();
  return citations.filter((c) => {
    const key = `${c.source}::${c.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
