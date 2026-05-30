/**
 * Finnhub news adapter. Key: ctx.metadata.finnhubKey.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { NewsAdapter } from '../adapter.js';
import type { NewsArticle, EarningsTranscript } from '../types.js';
import { newsFetch } from '../_fetch.js';

const BASE = 'https://finnhub.io/api/v1';

function extractKey(ctx: ExecutionContext): string {
  const key = ctx.metadata?.['finnhubKey'] as string | undefined;
  if (!key) throw new Error('Finnhub news: set metadata.finnhubKey in execution context.');
  return key;
}

async function fhGet(path: string, key: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('token', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await newsFetch(url.toString());
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}: ${path}`);
  return res.json();
}

function scoreText(text: string): { score: number; label: 'positive' | 'neutral' | 'negative' } {
  const pos = ['beat', 'record', 'growth', 'profit', 'raises', 'expands', 'accelerates', 'strong', 'surge', 'wins'];
  const neg = ['miss', 'cut', 'loss', 'decline', 'warn', 'fell', 'disappoints', 'antitrust', 'probe', 'concern'];
  const t = text.toLowerCase();
  let s = pos.filter(w => t.includes(w)).length - neg.filter(w => t.includes(w)).length;
  const score = Math.max(-1, Math.min(1, s * 0.25));
  return { score, label: score > 0.1 ? 'positive' : score < -0.1 ? 'negative' : 'neutral' };
}

export function finnhubNewsAdapter(): NewsAdapter {
  return {
    async getCompanyNews(ctx, params): Promise<NewsArticle[]> {
      const key = extractKey(ctx);
      const data = await fhGet('/company-news', key, { symbol: params.symbol, from: params.from, to: params.to }) as Array<Record<string, unknown>>;
      return (Array.isArray(data) ? data : []).slice(0, params.limit ?? 50).map(a => {
        const title = String(a['headline'] ?? '');
        const { score, label } = scoreText(title + ' ' + String(a['summary'] ?? ''));
        return {
          id: String(a['id'] ?? Math.random()), title, source: String(a['source'] ?? ''),
          url: String(a['url'] ?? ''), publishedAt: new Date(Number(a['datetime'] ?? 0) * 1000).toISOString(),
          summary: String(a['summary'] ?? '') || null, symbols: [params.symbol], topics: [],
          sentimentScore: score, sentimentLabel: label, relevanceScore: 0.8,
        };
      });
    },

    async getMarketNews(ctx, params): Promise<NewsArticle[]> {
      const key = extractKey(ctx);
      const category = params.topics?.[0] ?? 'general';
      const data = await fhGet('/news', key, { category }) as Array<Record<string, unknown>>;
      return (Array.isArray(data) ? data : []).slice(0, params.limit ?? 20).map(a => {
        const title = String(a['headline'] ?? '');
        const { score, label } = scoreText(title);
        return {
          id: String(a['id'] ?? Math.random()), title, source: String(a['source'] ?? ''),
          url: String(a['url'] ?? ''), publishedAt: new Date(Number(a['datetime'] ?? 0) * 1000).toISOString(),
          summary: String(a['summary'] ?? '') || null, symbols: [], topics: params.topics ?? [],
          sentimentScore: score, sentimentLabel: label, relevanceScore: 0.5,
        };
      });
    },

    async getEarningsTranscripts(): Promise<EarningsTranscript[]> { return []; },
  };
}
