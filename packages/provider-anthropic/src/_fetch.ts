/**
 * Hardened fetch for the Anthropic provider client. Default-on — no opt-in flag.
 * Phase 1: thin closure over `@weaveintel/core`'s `createHardenedFetch`.
 * See packages/provider-openai/src/_fetch.ts for the full rationale.
 */

import { createHardenedFetch } from '@weaveintel/core';

export interface AnthropicFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  enforceHttps?: boolean;
}

const client = createHardenedFetch({
  errorTag: 'provider-anthropic',
  timeoutMs: 120_000,
  maxBytes: 50 * 1024 * 1024,
});

export const assertHttpsOrLoopback = client.assertSafe;

export async function anthropicFetch(
  input: string,
  init?: RequestInit,
  opts: AnthropicFetchOptions = {},
): Promise<Response> {
  return client.fetch(input, init, opts);
}

export const anthropicFetchStream = client.fetchStream;
