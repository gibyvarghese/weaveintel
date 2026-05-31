/**
 * Hardened fetch for enterprise connectors (ServiceNow, etc.). Default-on.
 * Phase 1: thin closure over `@weaveintel/core`'s `createHardenedFetch`.
 */

import { createHardenedFetch } from '@weaveintel/core';

export interface EnterpriseFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Set false to skip HTTPS enforcement (e.g. operator already validated). */
  enforceHttps?: boolean;
}

const client = createHardenedFetch({
  errorTag: 'enterprise',
  timeoutMs: 30_000,
  maxBytes: 10 * 1024 * 1024,
});

export async function enterpriseFetch(
  input: string,
  init?: RequestInit,
  opts: EnterpriseFetchOptions = {},
): Promise<Response> {
  return client.fetch(input, init, opts);
}
