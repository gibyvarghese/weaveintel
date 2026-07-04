/**
 * Hardened fetch for market-data connectors. Default-on.
 * Phase 1: thin closure over `@weaveintel/core`'s `createHardenedFetch`.
 */

import { createHardenedFetch } from '@weaveintel/core';

export interface MarketDataFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  enforceHttps?: boolean;
}

const client = createHardenedFetch({
  errorTag: 'tools-marketdata',
  timeoutMs: 30_000,
  maxBytes: 10 * 1024 * 1024,
});

export async function marketdataFetch(
  input: string,
  init?: RequestInit,
  opts: MarketDataFetchOptions = {},
): Promise<Response> {
  return client.fetch(input, init, opts);
}
