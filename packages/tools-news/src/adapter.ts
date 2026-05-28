import type { ExecutionContext } from '@weaveintel/core';
import type { NewsArticle, EarningsTranscript, GetCompanyNewsParams, GetMarketNewsParams } from './types.js';

export interface NewsAdapter {
  getCompanyNews(ctx: ExecutionContext, params: GetCompanyNewsParams): Promise<NewsArticle[]>;
  getMarketNews(ctx: ExecutionContext, params: GetMarketNewsParams): Promise<NewsArticle[]>;
  getEarningsTranscripts(ctx: ExecutionContext, symbol: string, quarters: number): Promise<EarningsTranscript[]>;
}
