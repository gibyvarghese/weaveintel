/**
 * Jina AI Reader / Search provider
 */
import { BaseSearchProvider } from '../base.js';
import type { SearchResult, SearchOptions, SearchProviderConfig } from '../types.js';

export class JinaProvider extends BaseSearchProvider {
  readonly name = 'jina';

  async search(options: SearchOptions, config: SearchProviderConfig): Promise<SearchResult[]> {
    if (!config.apiKey) throw new Error('Jina requires an API key');
    const base = config.baseUrl ?? 'https://s.jina.ai';
    const data = await this.fetchJSON<{
      data?: Array<{ title: string; url: string; description?: string; content?: string }>;
    }>(`${base}/${encodeURIComponent(options.query)}`, {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: 'application/json',
      'X-Return-Format': 'text',
    });
    return (data.data ?? []).slice(0, options.limit ?? 10).map(r =>
      this.normalise({ title: r.title, url: r.url, snippet: r.description ?? r.content ?? '' }),
    );
  }
}
