/**
 * Hardened fetch for the llama.cpp provider client. Default-on — no opt-in flag.
 * Phase 1: thin closure over `@weaveintel/core`'s `createHardenedFetch`.
 */

import { createHardenedFetch } from '@weaveintel/core';

export interface LlamaCppFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  enforceHttps?: boolean;
}

const client = createHardenedFetch({
  errorTag: 'provider-llamacpp',
  timeoutMs: 60_000,
  maxBytes: 50 * 1024 * 1024,
});

export const assertHttpsOrLoopback = client.assertSafe;

export async function llamacppFetch(
  input: string,
  init?: RequestInit,
  opts: LlamaCppFetchOptions = {},
): Promise<Response> {
  return client.fetch(input, init, opts);
}

export const llamacppFetchStream = client.fetchStream;
