/**
 * Polygon.io live adapter.
 * Key supplied via ctx.metadata.polygonKey.
 * Strong coverage: OHLCV, options, short interest.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { MarketDataAdapter, OHLCVParams } from '../adapter.js';
import type {
  SymbolSearchResult, CompanyProfile, Quote, OHLCVBar, Fundamentals,
  AnnualFinancials, QuarterlyFinancials, EarningsEvent, AnalystConsensus,
  DividendEvent, SplitEvent, SECFilingRef, InsiderTransaction,
  InstitutionalHolding, ShortInterest, OptionsSummary, MacroSnapshot, FxRate,
} from '../types.js';

const BASE = 'https://api.polygon.io';

function extractKey(ctx: ExecutionContext): string {
  const key = ctx.metadata?.['polygonKey'] as string | undefined;
  if (!key) throw new Error('Polygon: set metadata.polygonKey in execution context.');
  return key;
}

async function polyGet(path: string, key: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('apiKey', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Polygon HTTP ${res.status}: ${path}`);
  return res.json();
}

export function polygonAdapter(): MarketDataAdapter {
  return {
    async searchSymbols(ctx, query): Promise<SymbolSearchResult[]> {
      const key = extractKey(ctx);
      const data = await polyGet('/v3/reference/tickers', key, { search: query, limit: '10' }) as { results?: Array<Record<string,unknown>> };
      return (data.results ?? []).map(r => ({
        symbol: String(r['ticker'] ?? ''), name: String(r['name'] ?? ''),
        exchange: (String(r['primary_exchange'] ?? 'OTHER')) as SymbolSearchResult['exchange'],
        type: String(r['type'] ?? null) || null, currency: String(r['currency_name'] ?? null) || null,
      }));
    },

    async getProfile(ctx, symbol): Promise<CompanyProfile> {
      const key = extractKey(ctx);
      const data = await polyGet(`/v3/reference/tickers/${symbol}`, key) as { results?: Record<string,unknown> };
      const p = data.results ?? {};
      return {
        symbol, name: String(p['name'] ?? symbol),
        exchange: (String(p['primary_exchange'] ?? 'OTHER')) as CompanyProfile['exchange'],
        sector: String(p['sic_description'] ?? '') || null, industry: String(p['sic_description'] ?? '') || null,
        country: String(p['locale'] ?? 'US').toUpperCase(),
        currency: String(p['currency_name'] ?? 'usd').toUpperCase(),
        ipoDate: String(p['list_date'] ?? '') || null,
        sharesOutstanding: p['share_class_shares_outstanding'] ? Number(p['share_class_shares_outstanding']) : (p['weighted_shares_outstanding'] ? Number(p['weighted_shares_outstanding']) : null),
        description: String(p['description'] ?? '') || null,
        website: String(p['homepage_url'] ?? '') || null,
        fiscalYearEnd: null,
      };
    },

    async getQuote(ctx, symbol): Promise<Quote> {
      const key = extractKey(ctx);
      const data = await polyGet(`/v2/last/trade/${symbol}`, key) as { results?: Record<string,unknown> };
      const r = data.results ?? {};
      const prev = await polyGet(`/v2/aggs/ticker/${symbol}/prev`, key) as { results?: Array<Record<string,unknown>> };
      const prevClose = (prev.results ?? [])[0]?.['c'] as number | undefined;
      return {
        symbol, price: Number(r['p'] ?? 0), currency: 'USD', ts: new Date(Number(r['t'] ?? 0) / 1_000_000).toISOString(),
        open: null, high: null, low: null, previousClose: prevClose ?? null,
        change: prevClose ? Number(r['p'] ?? 0) - prevClose : null,
        changePct: prevClose ? (Number(r['p'] ?? 0) - prevClose) / prevClose : null,
        volume: null,
      };
    },

    async getOHLCV(ctx, symbol, params: OHLCVParams): Promise<OHLCVBar[]> {
      const key = extractKey(ctx);
      const mult = 1;
      const span = params.interval === 'daily' ? 'day' : params.interval === 'weekly' ? 'week' : 'month';
      const data = await polyGet(`/v2/aggs/ticker/${symbol}/range/${mult}/${span}/${params.from}/${params.to}`, key, { limit: '5000', adjusted: 'true' }) as { results?: Array<Record<string,unknown>> };
      return (data.results ?? []).map(b => ({
        ts: new Date(Number(b['t'])).toISOString(), open: Number(b['o']), high: Number(b['h']),
        low: Number(b['l']), close: Number(b['c']), adjustedClose: Number(b['c']), volume: Number(b['v']),
      }));
    },

    async getFundamentals(_ctx, symbol): Promise<Fundamentals> {
      return {
        symbol, asOf: new Date().toISOString().slice(0,10), fiscalConvention: 'US_GAAP', currency: 'USD',
        marketCap: null, enterpriseValue: null, peRatio: null, forwardPE: null, pegRatio: null,
        pbRatio: null, psRatio: null, evToEbitda: null, evToSales: null, fcfYield: null, earningsYield: null,
        grossMargin: null, operatingMargin: null, netMargin: null, roe: null, roa: null, roic: null, grossProfitToAssets: null,
        epsTtm: null, dilutedEps: null, bookValuePerShare: null, fcfPerShare: null,
        dividendYield: null, payoutRatio: null, buybackYield: null, shareholderYield: null,
        debtToEquity: null, netDebtToEbitda: null, currentRatio: null, quickRatio: null,
        interestCoverage: null, altmanZScore: null, piotroskiFScore: null, beneishMScore: null,
        revenueGrowthYoy: null, epsGrowthYoy: null, fcfGrowthYoy: null, accrualsRatio: null, cfoToNetIncome: null,
      };
    },

    async getAnnualFinancials(_ctx, _symbol, _years): Promise<AnnualFinancials[]> { return []; },
    async getQuarterlyFinancials(_ctx, _symbol, _quarters): Promise<QuarterlyFinancials[]> { return []; },
    async getEarningsHistory(_ctx, _symbol, _quarters): Promise<EarningsEvent[]> { return []; },
    async getAnalystConsensus(_ctx, symbol): Promise<AnalystConsensus> {
      return { symbol, asOf: new Date().toISOString().slice(0,10), buyCount: 0, holdCount: 0, sellCount: 0, meanTargetPrice: null, medianTargetPrice: null, epsRevisions30d: null, epsRevisions90d: null, consensusEps1y: null, consensusEps2y: null, consensusRevenue1y: null, longTermGrowthEstimate: null };
    },

    async getDividends(ctx, symbol, years): Promise<DividendEvent[]> {
      const key = extractKey(ctx);
      const from = new Date(); from.setFullYear(from.getFullYear() - years);
      const data = await polyGet('/v3/reference/dividends', key, { ticker: symbol, 'ex_dividend_date.gte': from.toISOString().slice(0,10), limit: '100' }) as { results?: Array<Record<string,unknown>> };
      return (data.results ?? []).map(d => ({
        exDate: String(d['ex_dividend_date'] ?? ''), payDate: String(d['pay_date'] ?? '') || null,
        amount: Number(d['cash_amount'] ?? 0), currency: String(d['currency'] ?? 'USD'),
      }));
    },

    async getSplits(ctx, symbol): Promise<SplitEvent[]> {
      const key = extractKey(ctx);
      const data = await polyGet('/v3/reference/splits', key, { ticker: symbol, limit: '50' }) as { results?: Array<Record<string,unknown>> };
      return (data.results ?? []).map(s => ({
        exDate: String(s['execution_date'] ?? ''),
        numerator: Number(s['split_to'] ?? 1),
        denominator: Number(s['split_from'] ?? 1),
      }));
    },

    async getSECFilings(_ctx, _symbol, _formTypes): Promise<SECFilingRef[]> { return []; },
    async getInsiderTransactions(_ctx, _symbol, _days): Promise<InsiderTransaction[]> { return []; },
    async getInstitutionalHoldings(_ctx, _symbol): Promise<InstitutionalHolding[]> { return []; },

    async getShortInterest(ctx, symbol): Promise<ShortInterest> {
      // Polygon short interest endpoint (Launchpad/Business plan required)
      const key = extractKey(ctx);
      try {
        const data = await polyGet(`/v3/reference/short-interest/${symbol}`, key) as { results?: Record<string,unknown> };
        const r = data.results ?? {};
        return {
          symbol, asOf: String(r['settlement_date'] ?? new Date().toISOString().slice(0,10)),
          shortShares: Number(r['short_volume'] ?? 0),
          shortPctFloat: r['short_percent_of_float'] ? Number(r['short_percent_of_float']) : null,
          daysToCover: null, costToBorrow: null,
        };
      } catch {
        return { symbol, asOf: new Date().toISOString().slice(0,10), shortShares: 0, shortPctFloat: null, daysToCover: null, costToBorrow: null };
      }
    },

    async getOptionsSummary(ctx, symbol): Promise<OptionsSummary | null> {
      const key = extractKey(ctx);
      try {
        const data = await polyGet(`/v3/snapshot/options/${symbol}`, key) as { results?: Array<Record<string,unknown>> };
        const opts = data.results ?? [];
        const puts  = opts.filter(o => (o['details'] as Record<string,unknown>)?.['contract_type'] === 'put');
        const calls = opts.filter(o => (o['details'] as Record<string,unknown>)?.['contract_type'] === 'call');
        const sumOI = (arr: Array<Record<string,unknown>>) => arr.reduce((s, o) => s + Number((o['open_interest'] ?? 0)), 0);
        const putOI = sumOI(puts); const callOI = sumOI(calls);
        return {
          symbol, asOf: new Date().toISOString().slice(0,10),
          putCallRatioOI: callOI > 0 ? putOI / callOI : null,
          putCallRatioVolume: null, impliedVolatility30d: null, ivRank: null, skew25Delta: null,
          totalOpenInterest: putOI + callOI,
        };
      } catch { return null; }
    },

    async getMacroSnapshot(_ctx, region): Promise<MacroSnapshot> {
      return { asOf: new Date().toISOString().slice(0,10), region, policyRate: null, cpiYoy: null, gdpGrowthYoy: null, unemploymentRate: null, yieldCurve10y2y: null, vix: null };
    },

    async getFxRate(ctx, from, to): Promise<FxRate> {
      const key = extractKey(ctx);
      const data = await polyGet(`/v1/conversion/${from}/${to}`, key, { amount: '1', precision: '4' }) as { converted?: number; last?: Record<string,unknown> };
      return { from, to, rate: data.converted ?? 1, asOf: new Date().toISOString() };
    },
  };
}
