/**
 * Serper (Google Search Results API) provider
 */
import { BaseSearchProvider } from '../base.js';
import type { SearchResult, SearchOptions, SearchProviderConfig } from '../types.js';

export class SerperProvider extends BaseSearchProvider {
  readonly name = 'serper';

  async search(options: SearchOptions, config: SearchProviderConfig): Promise<SearchResult[]> {
    if (!config.apiKey) throw new Error('Serper requires an API key');
    const body = JSON.stringify({
      q: options.query,
      num: options.limit ?? 10,
      ...(options.language ? { hl: options.language } : {}),
    });
    const data = await this.fetchJSON<{
      organic?: Array<{ title: string; link: string; snippet?: string; date?: string; position?: number }>;
    }>('https://google.serper.dev/search', { 'X-API-KEY': config.apiKey, 'Content-Type': 'application/json' }, body);
    return (data.organic ?? []).map(r =>
      this.normalise({ title: r.title, url: r.link, snippet: r.snippet ?? '', publishedAt: r.date }),
    );
  }
}
