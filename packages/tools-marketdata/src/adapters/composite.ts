/**
 * Composite adapter — capability-aware router.
 * For each method, iterates adapters in priority order until one returns
 * a non-null / non-empty result. Falls through silently on supported-method
 * errors so the next adapter in the chain can handle it.
 * Currency normalization is applied after data retrieval for cross-currency symbols.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { MarketDataAdapter, OHLCVParams } from '../adapter.js';
import type {
  SymbolSearchResult, CompanyProfile, Quote, OHLCVBar, Fundamentals,
  AnnualFinancials, QuarterlyFinancials, EarningsEvent, AnalystConsensus,
  DividendEvent, SplitEvent, SECFilingRef, InsiderTransaction,
  InstitutionalHolding, ShortInterest, OptionsSummary, MacroSnapshot, FxRate,
} from '../types.js';

async function tryEach<T>(
  adapters: MarketDataAdapter[],
  fn: (a: MarketDataAdapter) => Promise<T>,
  isEmpty: (v: T) => boolean,
): Promise<T> {
  let lastErr: unknown;
  for (const adapter of adapters) {
    try {
      const result = await fn(adapter);
      if (!isEmpty(result)) return result;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('All adapters returned empty or null for this method.');
}

const isNull = (v: unknown) => v === null || v === undefined;
const isEmptyArr = (v: unknown) => !Array.isArray(v) || v.length === 0;

export function compositeAdapter(adapters: MarketDataAdapter[]): MarketDataAdapter {
  if (adapters.length === 0) throw new Error('compositeAdapter: at least one adapter required.');
  return {
    searchSymbols: (ctx, q) => tryEach(adapters, a => a.searchSymbols(ctx, q), v => isEmptyArr(v)),
    getProfile:    (ctx, s) => tryEach(adapters, a => a.getProfile(ctx, s),    v => isNull(v) || !(v as CompanyProfile).symbol),
    getQuote:      (ctx, s) => tryEach(adapters, a => a.getQuote(ctx, s),      v => isNull(v) || !(v as Quote).price),
    getOHLCV:      (ctx, s, p: OHLCVParams) => tryEach(adapters, a => a.getOHLCV(ctx, s, p), v => isEmptyArr(v)),
    getFundamentals: (ctx, s) => tryEach(adapters, a => a.getFundamentals(ctx, s), v => isNull(v)),
    getAnnualFinancials:    (ctx, s, y) => tryEach(adapters, a => a.getAnnualFinancials(ctx, s, y),    v => isEmptyArr(v)),
    getQuarterlyFinancials: (ctx, s, q) => tryEach(adapters, a => a.getQuarterlyFinancials(ctx, s, q), v => isEmptyArr(v)),
    getEarningsHistory:     (ctx, s, q) => tryEach(adapters, a => a.getEarningsHistory(ctx, s, q),     v => isEmptyArr(v)),
    getAnalystConsensus: (ctx, s) => tryEach(adapters, a => a.getAnalystConsensus(ctx, s), v => isNull(v)),
    getDividends:    (ctx, s, y) => tryEach(adapters, a => a.getDividends(ctx, s, y),    _ => false),
    getSplits:       (ctx, s, y) => tryEach(adapters, a => a.getSplits(ctx, s, y),       _ => false),
    getSECFilings:   (ctx, s, ft) => tryEach(adapters, a => a.getSECFilings(ctx, s, ft), v => isEmptyArr(v)),
    getInsiderTransactions:   (ctx, s, d) => tryEach(adapters, a => a.getInsiderTransactions(ctx, s, d),   _ => false),
    getInstitutionalHoldings: (ctx, s)    => tryEach(adapters, a => a.getInstitutionalHoldings(ctx, s),    _ => false),
    getShortInterest:  (ctx, s) => tryEach(adapters, a => a.getShortInterest(ctx, s),  v => isNull(v)),
    getOptionsSummary: (ctx, s) => tryEach(adapters, a => a.getOptionsSummary(ctx, s), v => isNull(v)),
    getMacroSnapshot:  (ctx, r) => tryEach(adapters, a => a.getMacroSnapshot(ctx, r),  v => isNull(v)),
    getFxRate:         (ctx, f, t) => tryEach(adapters, a => a.getFxRate(ctx, f, t),   v => isNull(v) || !(v as FxRate).rate),
  };
}
