/**
 * Hardened fetch for search connectors. Default-on.
 * Phase 1: thin closure over `@weaveintel/core`'s `createHardenedFetch`.
 */

import { createHardenedFetch } from '@weaveintel/core';

export interface SearchFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  enforceHttps?: boolean;
}

const client = createHardenedFetch({
  errorTag: 'tools-search',
  timeoutMs: 30_000,
  maxBytes: 10 * 1024 * 1024,
});

export async function searchFetch(
  input: string,
  init?: RequestInit,
  opts: SearchFetchOptions = {},
): Promise<Response> {
  return client.fetch(input, init, opts);
}
