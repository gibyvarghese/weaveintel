/**
 * MarketDataAdapter — provider-agnostic contract.
 * All live adapters and the fixture adapter implement this interface.
 * The composite adapter routes each method across multiple adapters.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type {
  SymbolSearchResult,
  CompanyProfile,
  Quote,
  OHLCVBar,
  Fundamentals,
  AnnualFinancials,
  QuarterlyFinancials,
  EarningsEvent,
  AnalystConsensus,
  DividendEvent,
  SplitEvent,
  SECFilingRef,
  InsiderTransaction,
  InstitutionalHolding,
  ShortInterest,
  OptionsSummary,
  MacroSnapshot,
  FxRate,
} from './types.js';

export interface OHLCVParams {
  interval: 'daily' | 'weekly' | 'monthly';
  from: string;  // ISO date
  to: string;    // ISO date
}

export interface MarketDataAdapter {
  searchSymbols(ctx: ExecutionContext, query: string): Promise<SymbolSearchResult[]>;
  getProfile(ctx: ExecutionContext, symbol: string): Promise<CompanyProfile>;
  getQuote(ctx: ExecutionContext, symbol: string): Promise<Quote>;
  getOHLCV(ctx: ExecutionContext, symbol: string, params: OHLCVParams): Promise<OHLCVBar[]>;
  getFundamentals(ctx: ExecutionContext, symbol: string): Promise<Fundamentals>;
  getAnnualFinancials(ctx: ExecutionContext, symbol: string, years: number): Promise<AnnualFinancials[]>;
  getQuarterlyFinancials(ctx: ExecutionContext, symbol: string, quarters: number): Promise<QuarterlyFinancials[]>;
  getEarningsHistory(ctx: ExecutionContext, symbol: string, quarters: number): Promise<EarningsEvent[]>;
  getAnalystConsensus(ctx: ExecutionContext, symbol: string): Promise<AnalystConsensus>;
  getDividends(ctx: ExecutionContext, symbol: string, years: number): Promise<DividendEvent[]>;
  getSplits(ctx: ExecutionContext, symbol: string, years: number): Promise<SplitEvent[]>;
  getSECFilings(ctx: ExecutionContext, symbol: string, formTypes?: string[]): Promise<SECFilingRef[]>;
  getInsiderTransactions(ctx: ExecutionContext, symbol: string, days: number): Promise<InsiderTransaction[]>;
  getInstitutionalHoldings(ctx: ExecutionContext, symbol: string): Promise<InstitutionalHolding[]>;
  getShortInterest(ctx: ExecutionContext, symbol: string): Promise<ShortInterest>;
  getOptionsSummary(ctx: ExecutionContext, symbol: string): Promise<OptionsSummary | null>;
  getMacroSnapshot(ctx: ExecutionContext, region: MacroSnapshot['region']): Promise<MacroSnapshot>;
  getFxRate(ctx: ExecutionContext, from: string, to: string): Promise<FxRate>;
}
