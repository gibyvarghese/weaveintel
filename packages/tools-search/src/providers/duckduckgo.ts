/**
 * DuckDuckGo Instant Answer API — no API key required.
 */
import { BaseSearchProvider } from '../base.js';
import type { SearchResult, SearchOptions, SearchProviderConfig } from '../types.js';

export class DuckDuckGoProvider extends BaseSearchProvider {
  readonly name = 'duckduckgo';

  async search(options: SearchOptions, _config: SearchProviderConfig): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: options.query, format: 'json', no_html: '1', skip_disambig: '1' });
    const data = await this.fetchJSON<{
      AbstractText?: string; AbstractURL?: string; AbstractSource?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
    }>(`https://api.duckduckgo.com/?${params.toString()}`);

    const results: SearchResult[] = [];
    if (data.AbstractText && data.AbstractURL) {
      results.push(this.normalise({ title: data.AbstractSource ?? 'DuckDuckGo', url: data.AbstractURL, snippet: data.AbstractText }));
    }
    const limit = options.limit ?? 10;
    for (const topic of data.RelatedTopics ?? []) {
      if (results.length >= limit) break;
      if (topic.Text && topic.FirstURL) {
        results.push(this.normalise({ title: topic.Text.slice(0, 80), url: topic.FirstURL, snippet: topic.Text }));
      }
    }
    return results;
  }
}
