/**
 * URL fetcher — retrieves web pages with timeout and redirect handling
 */
import { readResponseTextLimited, validateOutboundUrl } from '@weaveintel/tools';
import type { FetchOptions, FetchResult } from './types.js';

export async function fetchPage(options: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  const parsedUrl = await validateOutboundUrl(options.url, {
    allowedHosts: options.allowedHosts,
    blockedHosts: options.blockedHosts,
    allowPrivateNetwork: options.allowPrivateNetwork,
  });
  const controller = new AbortController();
  const timeoutId = options.timeout ? setTimeout(() => controller.abort(), options.timeout) : undefined;
  const maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
  try {
    const resp = await fetch(parsedUrl.toString(), {
      method: options.method ?? 'GET',
      headers: { 'User-Agent': 'WeaveIntel-Browser/1.0', ...(options.headers ?? {}) },
      redirect: options.followRedirects === false ? 'manual' : 'follow',
      signal: controller.signal,
    });
    const html = await readResponseTextLimited(resp, maxResponseBytes, controller.signal);
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    return { url: resp.url, status: resp.status, headers, html, latencyMs: Date.now() - start };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
