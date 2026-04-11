/**
 * @weaveintel/tools-search — Base search adapter
 *
 * Common HTTP fetch logic shared by all search providers.
 */

import type { SearchResult, SearchOptions, SearchProviderConfig, SearchProvider } from './types.js';

export abstract class BaseSearchProvider implements SearchProvider {
  abstract readonly name: string;
  abstract search(options: SearchOptions, config: SearchProviderConfig): Promise<SearchResult[]>;

  protected async fetchJSON<T>(url: string, headers?: Record<string, string>, body?: string): Promise<T> {
    const init: RequestInit = { headers: { 'Accept': 'application/json', ...headers } };
    if (body !== undefined) { init.method = 'POST'; init.body = body; }
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} — ${res.statusText}`);
    return res.json() as Promise<T>;
  }

  protected normalise(raw: Partial<SearchResult> & { title: string; url: string }): SearchResult {
    return {
      title: raw.title,
      url: raw.url,
      snippet: raw.snippet ?? '',
      source: this.name,
      publishedAt: raw.publishedAt,
      score: raw.score,
      metadata: raw.metadata,
    };
  }
}
