export interface NewsArticle {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: string;  // ISO 8601
  summary: string | null;
  symbols: string[];
  topics: string[];
  sentimentScore: number | null;      // -1..+1
  sentimentLabel: 'positive' | 'neutral' | 'negative' | null;
  relevanceScore: number | null;      // 0..1
}

export interface EarningsTranscript {
  fiscalPeriod: string;   // e.g. "2025-Q3"
  reportDate: string;
  text: string;
  url: string;
}

export interface GetCompanyNewsParams {
  symbol: string;
  from: string;           // ISO date
  to: string;             // ISO date
  limit?: number;
}

export interface GetMarketNewsParams {
  topics?: string[];
  region?: 'US' | 'IN' | 'EU' | 'UK' | 'GLOBAL';
  limit?: number;
}
