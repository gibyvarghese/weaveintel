/**
 * Hardened fetch for A2A client task posts and streams. Default-on.
 * Phase 1: thin closure over `@weaveintel/core`'s `createHardenedFetch`.
 */

import { createHardenedFetch } from '@weaveintel/core';

export interface A2AFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  enforceHttps?: boolean;
}

const client = createHardenedFetch({
  errorTag: 'a2a',
  timeoutMs: 30_000,
  maxBytes: 10 * 1024 * 1024,
  // An agent on this machine (http://127.0.0.1) stays reachable, as it was before @weaveintel/core 0.2.0
  // made loopback opt-in: said here explicitly, so the default protects every caller that does not say so.
  policy: { allowLoopback: true },
});

export const assertHttpsOrLoopback = client.assertSafe;

export async function a2aFetch(
  input: string,
  init?: RequestInit,
  opts: A2AFetchOptions = {},
): Promise<Response> {
  return client.fetch(input, init, opts);
}

export const a2aFetchStream = client.fetchStream;
