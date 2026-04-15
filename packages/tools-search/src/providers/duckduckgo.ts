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

    // The Instant Answer API is intentionally narrow and often returns no items
    // for real-world web queries; fall back to the public HTML results page.
    if (results.length === 0) {
      return this.searchHtmlResults(options);
    }

    return results;
  }

  private async searchHtmlResults(options: SearchOptions): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: options.query, kl: 'wt-wt' });
    const res = await fetch(`https://html.duckduckgo.com/html/?${params.toString()}`, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (compatible; weaveintel-tools-search/1.0)',
      },
    });
    if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} — ${res.statusText}`);

    const html = await res.text();
    const limit = options.limit ?? 10;
    const results: SearchResult[] = [];

    // Parse result blocks anchored by result links and nearby snippets.
    const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = anchorRe.exec(html)) && results.length < limit) {
      const rawHref = match[1] ?? '';
      const decodedHref = this.decodeDuckDuckGoRedirect(rawHref);
      if (!decodedHref) continue;

      const title = this.cleanHtml(match[2] ?? '').trim();
      if (!title) continue;

      const snippetStart = anchorRe.lastIndex;
      const snippetWindow = html.slice(snippetStart, snippetStart + 1200);
      const snippetMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\//i.exec(snippetWindow);
      const snippet = this.cleanHtml((snippetMatch?.[1] ?? snippetMatch?.[2] ?? '').trim());

      results.push(this.normalise({ title, url: decodedHref, snippet }));
    }

    return results;
  }

  private decodeDuckDuckGoRedirect(href: string): string | null {
    try {
      const resolved = href.startsWith('http') ? href : `https://duckduckgo.com${href.startsWith('/') ? '' : '/'}${href}`;
      const url = new URL(resolved);
      const redirectTarget = url.searchParams.get('uddg');
      if (redirectTarget) return decodeURIComponent(redirectTarget);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
      return null;
    } catch {
      return null;
    }
  }

  private cleanHtml(input: string): string {
    return input
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
