/**
 * Hardened fetch for the Google provider client. Default-on — no opt-in flag.
 * Phase 1: thin closure over `@weaveintel/core`'s `createHardenedFetch`.
 */

import { createHardenedFetch } from '@weaveintel/core';

export interface GoogleFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  enforceHttps?: boolean;
}

const client = createHardenedFetch({
  errorTag: 'provider-google',
  timeoutMs: 60_000,
  maxBytes: 50 * 1024 * 1024,
});

export const assertHttpsOrLoopback = client.assertSafe;

export async function googleFetch(
  input: string,
  init?: RequestInit,
  opts: GoogleFetchOptions = {},
): Promise<Response> {
  return client.fetch(input, init, opts);
}

export const googleFetchStream = client.fetchStream;
