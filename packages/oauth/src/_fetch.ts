/**
 * Internal safe-fetch helper for OAuth token + userinfo requests.
 *
 * Phase 1: the underlying request now flows through `@weaveintel/core`'s
 * `createHardenedFetch` (SSRF + redirect re-validation + 15s timeout + 1 MiB
 * size cap). This wrapper still consumes the body, parses JSON
 * tolerantly, and returns the legacy `OauthFetchResult` shape so callers
 * don't change.
 */

import { createHardenedFetch } from '@weaveintel/core';

export interface OauthFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export interface OauthFetchResult {
  ok: boolean;
  status: number;
  text: string;
  data: unknown;
}

const client = createHardenedFetch({
  errorTag: 'oauth',
  timeoutMs: 15_000,
  maxBytes: 1 * 1024 * 1024,
});

export async function oauthFetch(
  input: string,
  init: RequestInit = {},
  opts: OauthFetchOptions = {},
): Promise<OauthFetchResult> {
  const resp = await client.fetch(input, init, opts);
  const text = await resp.text();
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { ok: resp.ok, status: resp.status, text, data };
}
