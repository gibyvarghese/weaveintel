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
  // A local model server is ON this machine: loopback is what it is for. Said explicitly because
  // @weaveintel/core 0.2.0 refuses loopback unless the caller allows it.
  policy: { allowLoopback: true },
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
