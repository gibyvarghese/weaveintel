/**
 * Exa (formerly Metaphor) neural search provider
 */
import { BaseSearchProvider } from '../base.js';
import type { SearchResult, SearchOptions, SearchProviderConfig } from '../types.js';

export class ExaProvider extends BaseSearchProvider {
  readonly name = 'exa';

  async search(options: SearchOptions, config: SearchProviderConfig): Promise<SearchResult[]> {
    if (!config.apiKey) throw new Error('Exa requires an API key');
    const base = config.baseUrl ?? 'https://api.exa.ai';
    const body = JSON.stringify({
      query: options.query,
      numResults: options.limit ?? 10,
      type: 'neural',
      useAutoprompt: true,
      contents: { text: { maxCharacters: 500 } },
    });
    const data = await this.fetchJSON<{
      results?: Array<{ title: string; url: string; text?: string; score?: number; publishedDate?: string }>;
    }>(`${base}/search`, { 'x-api-key': config.apiKey, 'Content-Type': 'application/json' }, body);
    return (data.results ?? []).map(r =>
      this.normalise({ title: r.title, url: r.url, snippet: r.text ?? '', score: r.score, publishedAt: r.publishedDate }),
    );
  }
}
