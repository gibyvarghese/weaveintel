/**
 * Hardened fetch for news connectors. Default-on.
 * Phase 1: thin closure over `@weaveintel/core`'s `createHardenedFetch`.
 */

import { createHardenedFetch } from '@weaveintel/core';

export interface NewsFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  enforceHttps?: boolean;
}

const client = createHardenedFetch({
  errorTag: 'tools-news',
  timeoutMs: 30_000,
  maxBytes: 10 * 1024 * 1024,
});

export async function newsFetch(
  input: string,
  init?: RequestInit,
  opts: NewsFetchOptions = {},
): Promise<Response> {
  return client.fetch(input, init, opts);
}
