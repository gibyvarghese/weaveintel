/**
 * Shared safe-fetch helper for CSE cluster-API and cloud-token requests.
 *
 * Phase 1: the underlying request now flows through `@weaveintel/core`'s
 * `createHardenedFetch` (SSRF + redirect re-validation + 30s timeout + 10
 * MiB size cap). This wrapper still consumes the body, parses JSON
 * tolerantly, and returns the legacy `CseFetchResult` shape so callers
 * don't change.
 */

import { createHardenedFetch } from '@weaveintel/core';

export interface CseFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export interface CseFetchResult {
  ok: boolean;
  status: number;
  text: string;
  data: unknown;
}

const client = createHardenedFetch({
  errorTag: 'cse',
  timeoutMs: 30_000,
  maxBytes: 10 * 1024 * 1024,
});

export async function cseFetch(
  input: string,
  init: RequestInit & { dispatcher?: unknown } = {},
  opts: CseFetchOptions = {},
): Promise<CseFetchResult> {
  const { dispatcher: _dispatcher, ...passthrough } = init;
  void _dispatcher;
  const resp = await client.fetch(input, passthrough, opts);
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
