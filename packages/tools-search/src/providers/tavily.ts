/**
 * Tavily AI Search provider
 */
import { BaseSearchProvider } from '../base.js';
import type { SearchResult, SearchOptions, SearchProviderConfig } from '../types.js';

export class TavilyProvider extends BaseSearchProvider {
  readonly name = 'tavily';

  async search(options: SearchOptions, config: SearchProviderConfig): Promise<SearchResult[]> {
    if (!config.apiKey) throw new Error('Tavily requires an API key');
    const body = JSON.stringify({
      api_key: config.apiKey,
      query: options.query,
      max_results: options.limit ?? 10,
      search_depth: (config.options?.['depth'] as string) ?? 'basic',
      include_answer: false,
    });
    const data = await this.fetchJSON<{
      results?: Array<{ title: string; url: string; content?: string; score?: number; published_date?: string }>;
    }>('https://api.tavily.com/search', { 'Content-Type': 'application/json' }, body);
    return (data.results ?? []).map(r =>
      this.normalise({ title: r.title, url: r.url, snippet: r.content ?? '', score: r.score, publishedAt: r.published_date }),
    );
  }
}
