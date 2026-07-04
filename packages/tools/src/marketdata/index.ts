// SPDX-License-Identifier: MIT
export { createMarketDataMCPServer, type MarketDataMCPServerOptions } from './marketdata.js';
export { type MarketDataAdapter, type OHLCVParams } from './adapter.js';
export { fixtureMarketDataAdapter } from './adapters/fixture.js';
export { alphaVantageAdapter } from './adapters/alphavantage.js';
export { finnhubAdapter } from './adapters/finnhub.js';
export { fmpAdapter } from './adapters/fmp.js';
export { polygonAdapter } from './adapters/polygon.js';
export { secEdgarAdapter } from './adapters/sec-edgar.js';
export { compositeAdapter } from './adapters/composite.js';
export {
  wrapAdapterWithResilience,
  getMarketDataBreakerState,
  __resetBreakerStateForTests,
  MarketDataRateLimitError,
} from './resilience.js';
export type {
  FiscalConvention, Exchange, SymbolSearchResult, CompanyProfile, Quote,
  OHLCVBar, Fundamentals, AnnualFinancials, QuarterlyFinancials,
  EarningsEvent, AnalystConsensus, DividendEvent, SplitEvent,
  SECFilingRef, InsiderTransaction, InstitutionalHolding, ShortInterest,
  OptionsSummary, MacroSnapshot, FxRate,
} from './types.js';
