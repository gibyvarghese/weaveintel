/**
 * URL fetcher — retrieves web pages with timeout and redirect handling
 */
import type { FetchOptions, FetchResult } from './types.js';

export async function fetchPage(options: FetchOptions): Promise<FetchResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timeoutId = options.timeout ? setTimeout(() => controller.abort(), options.timeout) : undefined;
  try {
    const resp = await fetch(options.url, {
      method: options.method ?? 'GET',
      headers: { 'User-Agent': 'WeaveIntel-Browser/1.0', ...(options.headers ?? {}) },
      redirect: options.followRedirects === false ? 'manual' : 'follow',
      signal: controller.signal,
    });
    const html = await resp.text();
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });
    return { url: resp.url, status: resp.status, headers, html, latencyMs: Date.now() - start };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
