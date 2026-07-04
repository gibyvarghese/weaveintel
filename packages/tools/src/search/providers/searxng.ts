/**
 * SearXNG (self-hosted meta-search) provider
 */
import { BaseSearchProvider } from '../base.js';
import type { SearchResult, SearchOptions, SearchProviderConfig } from '../types.js';

export class SearXNGProvider extends BaseSearchProvider {
  readonly name = 'searxng';

  async search(options: SearchOptions, config: SearchProviderConfig): Promise<SearchResult[]> {
    const base = config.baseUrl ?? 'https://searx.be';
    const params = new URLSearchParams({ q: options.query, format: 'json' });
    if (options.limit) params.set('pageno', '1');
    if (options.language) params.set('language', options.language);
    if (options.safeSearch) params.set('safesearch', '2');
    const data = await this.fetchJSON<{
      results?: Array<{ title: string; url: string; content?: string; publishedDate?: string; score?: number }>;
    }>(`${base}/search?${params.toString()}`);
    return (data.results ?? []).slice(0, options.limit ?? 10).map(r =>
      this.normalise({ title: r.title, url: r.url, snippet: r.content ?? '', publishedAt: r.publishedDate, score: r.score }),
    );
  }
}
