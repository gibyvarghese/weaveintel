/**
 * Bing Web Search API v7 provider
 */
import { BaseSearchProvider } from '../base.js';
import type { SearchResult, SearchOptions, SearchProviderConfig } from '../types.js';

export class BingProvider extends BaseSearchProvider {
  readonly name = 'bing';

  async search(options: SearchOptions, config: SearchProviderConfig): Promise<SearchResult[]> {
    if (!config.apiKey) throw new Error('Bing Search requires an API key');
    const base = config.baseUrl ?? 'https://api.bing.microsoft.com/v7.0/search';
    const params = new URLSearchParams({ q: options.query, count: String(options.limit ?? 10) });
    if (options.language) params.set('mkt', options.language);
    if (options.safeSearch) params.set('safeSearch', 'Strict');
    const data = await this.fetchJSON<{
      webPages?: { value?: Array<{ name: string; url: string; snippet?: string; dateLastCrawled?: string }> };
    }>(`${base}?${params.toString()}`, { 'Ocp-Apim-Subscription-Key': config.apiKey });
    return (data.webPages?.value ?? []).map(r =>
      this.normalise({ title: r.name, url: r.url, snippet: r.snippet ?? '', publishedAt: r.dateLastCrawled }),
    );
  }
}
