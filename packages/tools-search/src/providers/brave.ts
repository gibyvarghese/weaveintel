/**
 * Brave Search API
 */
import { BaseSearchProvider } from '../base.js';
import type { SearchResult, SearchOptions, SearchProviderConfig } from '../types.js';

export class BraveProvider extends BaseSearchProvider {
  readonly name = 'brave';

  async search(options: SearchOptions, config: SearchProviderConfig): Promise<SearchResult[]> {
    if (!config.apiKey) throw new Error('Brave Search requires an API key');
    const params = new URLSearchParams({ q: options.query, count: String(options.limit ?? 10) });
    if (options.language) params.set('search_lang', options.language);
    const data = await this.fetchJSON<{
      web?: { results?: Array<{ title: string; url: string; description?: string; age?: string }> };
    }>(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
      'X-Subscription-Token': config.apiKey,
    });
    return (data.web?.results ?? []).map(r => this.normalise({ title: r.title, url: r.url, snippet: r.description ?? '', publishedAt: r.age }));
  }
}
