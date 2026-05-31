/**
 * Hardened fetch for social connectors. Default-on.
 * Phase 1: thin closure over `@weaveintel/core`'s `createHardenedFetch`.
 */

import { createHardenedFetch } from '@weaveintel/core';

export interface SocialFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  enforceHttps?: boolean;
}

const client = createHardenedFetch({
  errorTag: 'tools-social',
  timeoutMs: 30_000,
  maxBytes: 10 * 1024 * 1024,
});

export async function socialFetch(
  input: string,
  init?: RequestInit,
  opts: SocialFetchOptions = {},
): Promise<Response> {
  return client.fetch(input, init, opts);
}
