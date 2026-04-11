/**
 * Google Programmable Search Engine (PSE) provider
 */
import { BaseSearchProvider } from '../base.js';
import type { SearchResult, SearchOptions, SearchProviderConfig } from '../types.js';

export class GooglePSEProvider extends BaseSearchProvider {
  readonly name = 'google-pse';

  async search(options: SearchOptions, config: SearchProviderConfig): Promise<SearchResult[]> {
    const cx = config.options?.['cx'] as string | undefined;
    if (!config.apiKey || !cx) throw new Error('Google PSE requires apiKey and options.cx');
    const params = new URLSearchParams({ key: config.apiKey, cx, q: options.query, num: String(options.limit ?? 10) });
    if (options.language) params.set('lr', `lang_${options.language}`);
    if (options.safeSearch) params.set('safe', 'active');
    const data = await this.fetchJSON<{
      items?: Array<{ title: string; link: string; snippet?: string; pagemap?: { metatags?: Array<Record<string, string>> } }>;
    }>(`https://www.googleapis.com/customsearch/v1?${params.toString()}`);
    return (data.items ?? []).map(r => this.normalise({ title: r.title, url: r.link, snippet: r.snippet ?? '' }));
  }
}
