/**
 * FMP news + earnings transcripts adapter. Key: ctx.metadata.fmpKey.
 * FMP is the only major provider that offers earnings call transcripts.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { NewsAdapter } from '../adapter.js';
import type { NewsArticle, EarningsTranscript } from '../types.js';
import { newsFetch } from '../_fetch.js';

const BASE = 'https://financialmodelingprep.com/api/v3';

function extractKey(ctx: ExecutionContext): string {
  const key = ctx.metadata?.['fmpKey'] as string | undefined;
  if (!key) throw new Error('FMP news: set metadata.fmpKey in execution context.');
  return key;
}

async function fmpGet(path: string, key: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('apikey', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await newsFetch(url.toString());
  if (!res.ok) throw new Error(`FMP HTTP ${res.status}: ${path}`);
  return res.json();
}

export function fmpNewsAdapter(): NewsAdapter {
  return {
    async getCompanyNews(ctx, params): Promise<NewsArticle[]> {
      const key = extractKey(ctx);
      const data = await fmpGet(`/stock_news`, key, { tickers: params.symbol, from: params.from, to: params.to, limit: String(params.limit ?? 50) }) as Array<Record<string, unknown>>;
      return (Array.isArray(data) ? data : []).map(a => ({
        id: String(a['url'] ?? Math.random()), title: String(a['title'] ?? ''),
        source: String(a['site'] ?? ''), url: String(a['url'] ?? ''),
        publishedAt: String(a['publishedDate'] ?? ''), summary: String(a['text'] ?? '').slice(0, 500) || null,
        symbols: [params.symbol], topics: [],
        sentimentScore: a['sentiment'] !== undefined ? Number(a['sentiment']) : null,
        sentimentLabel: null, relevanceScore: null,
      }));
    },

    async getMarketNews(ctx, params): Promise<NewsArticle[]> {
      const key = extractKey(ctx);
      const data = await fmpGet('/stock_news', key, { limit: String(params.limit ?? 20) }) as Array<Record<string, unknown>>;
      return (Array.isArray(data) ? data : []).map(a => ({
        id: String(a['url'] ?? Math.random()), title: String(a['title'] ?? ''),
        source: String(a['site'] ?? ''), url: String(a['url'] ?? ''),
        publishedAt: String(a['publishedDate'] ?? ''), summary: String(a['text'] ?? '').slice(0, 500) || null,
        symbols: [], topics: params.topics ?? [],
        sentimentScore: null, sentimentLabel: null, relevanceScore: null,
      }));
    },

    async getEarningsTranscripts(ctx, symbol, quarters): Promise<EarningsTranscript[]> {
      const key = extractKey(ctx);
      const data = await fmpGet(`/earning_call_transcript/${symbol}`, key, { limit: String(quarters) }) as Array<Record<string, unknown>>;
      return (Array.isArray(data) ? data : []).map(t => ({
        fiscalPeriod: `${t['year']}-Q${t['quarter']}`,
        reportDate: String(t['date'] ?? ''),
        text: String(t['content'] ?? ''),
        url: `https://financialmodelingprep.com/financial-statements/${symbol}`,
      }));
    },
  };
}
