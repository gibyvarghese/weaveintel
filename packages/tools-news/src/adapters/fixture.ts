/**
 * Deterministic fixture news adapter. No network. Safe for CI.
 * Generates realistic-looking articles and transcripts for US/NSE tickers.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { NewsAdapter } from '../adapter.js';
import type { NewsArticle, EarningsTranscript } from '../types.js';

const FIXTURE_ARTICLES: NewsArticle[] = [
  { id: 'n001', title: 'Apple Reports Record Q2 Revenue Driven by Services Growth', source: 'Bloomberg', url: 'https://bloomberg.com/n001', publishedAt: '2026-05-15T14:30:00Z', summary: 'Apple Inc. delivered record quarterly revenue, fueled by 20% growth in its Services segment.', symbols: ['AAPL'], topics: ['earnings', 'technology'], sentimentScore: 0.72, sentimentLabel: 'positive', relevanceScore: 0.95 },
  { id: 'n002', title: 'Microsoft Azure Revenue Accelerates on AI Workload Demand', source: 'Reuters', url: 'https://reuters.com/n002', publishedAt: '2026-05-10T11:00:00Z', summary: 'Microsoft cloud division saw 35% revenue growth as enterprises deployed AI infrastructure at scale.', symbols: ['MSFT'], topics: ['cloud', 'AI', 'technology'], sentimentScore: 0.81, sentimentLabel: 'positive', relevanceScore: 0.92 },
  { id: 'n003', title: 'Alphabet Faces Antitrust Scrutiny in EU Over Search Dominance', source: 'FT', url: 'https://ft.com/n003', publishedAt: '2026-05-08T09:00:00Z', summary: 'European regulators are investigating Alphabet\'s dominance in online search advertising.', symbols: ['GOOGL'], topics: ['regulation', 'antitrust'], sentimentScore: -0.45, sentimentLabel: 'negative', relevanceScore: 0.88 },
  { id: 'n004', title: 'Johnson & Johnson Raises Full-Year Guidance on Strong Pharma Pipeline', source: 'WSJ', url: 'https://wsj.com/n004', publishedAt: '2026-04-28T16:00:00Z', summary: 'J&J lifted its 2026 earnings outlook citing a robust pharmaceutical pipeline and stable medical device segment.', symbols: ['JNJ'], topics: ['earnings', 'healthcare'], sentimentScore: 0.65, sentimentLabel: 'positive', relevanceScore: 0.91 },
  { id: 'n005', title: 'ExxonMobil Boosts Buyback Program to $20B as Oil Prices Stabilize', source: 'Reuters', url: 'https://reuters.com/n005', publishedAt: '2026-04-22T13:00:00Z', summary: 'ExxonMobil announced an expanded share repurchase program supported by improved free cash flow.', symbols: ['XOM'], topics: ['buyback', 'energy'], sentimentScore: 0.58, sentimentLabel: 'positive', relevanceScore: 0.87 },
  { id: 'n006', title: 'Reliance Jio Crosses 500M Subscriber Milestone', source: 'Economic Times', url: 'https://economictimes.com/n006', publishedAt: '2026-05-01T10:30:00Z', summary: 'Reliance Industries subsidiary Jio reached a landmark 500 million subscriber base, cementing its leadership in Indian telecom.', symbols: ['RELIANCE'], topics: ['telecom', 'growth'], sentimentScore: 0.78, sentimentLabel: 'positive', relevanceScore: 0.93 },
  { id: 'n007', title: 'TCS Wins $1.5B Multi-Year AI Transformation Deal', source: 'Mint', url: 'https://livemint.com/n007', publishedAt: '2026-04-18T08:00:00Z', summary: 'Tata Consultancy Services secured a major AI modernization contract with a European banking client.', symbols: ['TCS'], topics: ['IT services', 'AI', 'deal-win'], sentimentScore: 0.83, sentimentLabel: 'positive', relevanceScore: 0.96 },
  { id: 'n008', title: 'Infosys Cuts Revenue Guidance Amid Macro Headwinds', source: 'Bloomberg Quint', url: 'https://bloombergquint.com/n008', publishedAt: '2026-04-15T11:30:00Z', summary: 'Infosys lowered its full-year revenue growth guidance to 4-6% from 6-8%, citing slow client spending in Europe and North America.', symbols: ['INFY'], topics: ['earnings', 'guidance'], sentimentScore: -0.52, sentimentLabel: 'negative', relevanceScore: 0.90 },
  { id: 'n009', title: 'Fed Holds Rates at 4.25% — Signals Two Cuts in H2 2026', source: 'CNBC', url: 'https://cnbc.com/n009', publishedAt: '2026-05-07T19:00:00Z', summary: 'The Federal Reserve kept benchmark rates unchanged while hinting at possible cuts if inflation continues to moderate.', symbols: [], topics: ['macro', 'interest-rates', 'fed'], sentimentScore: 0.12, sentimentLabel: 'neutral', relevanceScore: 0.70 },
  { id: 'n010', title: 'Tech Sector Rally Continues as AI Sentiment Boosts Valuations', source: 'MarketWatch', url: 'https://marketwatch.com/n010', publishedAt: '2026-05-20T15:00:00Z', summary: 'Technology stocks extended their 2026 rally as generative AI adoption drove upward earnings revisions.', symbols: ['AAPL', 'MSFT', 'GOOGL'], topics: ['technology', 'AI', 'market-trend'], sentimentScore: 0.67, sentimentLabel: 'positive', relevanceScore: 0.75 },
];

function makeTranscript(symbol: string, quarter: string): EarningsTranscript {
  return {
    fiscalPeriod: quarter,
    reportDate: `2026-04-30`,
    text: `[${symbol} ${quarter} Earnings Call Transcript]\n\nCEO: We delivered exceptional results this quarter with strong growth across all segments. Our focus on operational efficiency and strategic investments in high-growth areas continues to drive value for shareholders.\n\nCFO: Revenue grew ${symbol === 'INFY' ? '4.8' : '12.1'}% year-over-year to record levels. Operating margin expanded 80 basis points. Free cash flow conversion remained robust at 115% of net income.\n\nAnalyst Q&A: [Q] What is your outlook for H2 2026? [A] We remain confident in sustained demand. [Q] Can you comment on AI-driven efficiency gains? [A] We expect meaningful productivity improvements to flow through margins over the next 12 months.\n\n[END OF TRANSCRIPT]`,
    url: `https://seekingalpha.com/article/${symbol.toLowerCase()}-${quarter.replace('-','').toLowerCase()}-earnings-transcript`,
  };
}

export function fixtureNewsAdapter(): NewsAdapter {
  return {
    async getCompanyNews(_ctx, params) {
      const from = new Date(params.from).getTime();
      const to   = new Date(params.to).getTime();
      return FIXTURE_ARTICLES
        .filter(a => a.symbols.includes(params.symbol))
        .filter(a => { const t = new Date(a.publishedAt).getTime(); return t >= from && t <= to; })
        .slice(0, params.limit ?? 50);
    },

    async getMarketNews(_ctx, params) {
      const topics = params.topics ?? [];
      return FIXTURE_ARTICLES
        .filter(a => topics.length === 0 || topics.some(t => a.topics.includes(t)))
        .slice(0, params.limit ?? 20);
    },

    async getEarningsTranscripts(_ctx, symbol, quarters) {
      const results: EarningsTranscript[] = [];
      for (let i = 0; i < quarters; i++) {
        const yr = 2026 - Math.floor(i / 4);
        const q = 4 - (i % 4);
        results.push(makeTranscript(symbol, `${yr}-Q${q}`));
      }
      return results;
    },
  };
}
