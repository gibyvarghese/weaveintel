/**
 * Hardened fetch for the OpenAI provider client. Default-on — no opt-in flag.
 *
 * Phase 1 of the enterprise-hardening plan: this file is now a thin closure
 * over the single hardened egress client in `@weaveintel/core`. The previous
 * hand-rolled timeout / size-cap / redirect / SSRF pipeline lives in
 * `packages/core/src/hardened-fetch.ts` and is shared by every provider /
 * tool / connector package — extending it (new SSRF rule, tighter TLS floor,
 * additional auditing hook) happens in one place.
 *
 * SSE / NDJSON streaming endpoints (chat.completions stream, big file
 * downloads) call `assertHttpsOrLoopback(url)` and then either
 * `openaiFetchStream(url, init)` or a plain `fetch(url, …)` so the outer
 * timeout / size cap don't terminate a healthy stream.
 */

import { createHardenedFetch } from '@weaveintel/core';

export interface OpenAIFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  enforceHttps?: boolean;
}

const client = createHardenedFetch({
  errorTag: 'provider-openai',
  timeoutMs: 120_000,
  maxBytes: 50 * 1024 * 1024,
});

export const assertHttpsOrLoopback = client.assertSafe;

export async function openaiFetch(
  input: string,
  init?: RequestInit,
  opts: OpenAIFetchOptions = {},
): Promise<Response> {
  return client.fetch(input, init, opts);
}

export const openaiFetchStream = client.fetchStream;
