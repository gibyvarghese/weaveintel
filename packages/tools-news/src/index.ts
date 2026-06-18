// SPDX-License-Identifier: MIT
export { createNewsMCPServer, type NewsMCPServerOptions } from './news.js';
export { type NewsAdapter } from './adapter.js';
export { fixtureNewsAdapter } from './adapters/fixture.js';
export { finnhubNewsAdapter } from './adapters/finnhub.js';
export { fmpNewsAdapter } from './adapters/fmp.js';
export type { NewsArticle, EarningsTranscript, GetCompanyNewsParams, GetMarketNewsParams } from './types.js';
