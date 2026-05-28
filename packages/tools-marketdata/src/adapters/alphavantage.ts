/**
 * Alpha Vantage live adapter.
 * Key supplied via ctx.metadata.alphaVantageKey.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { MarketDataAdapter, OHLCVParams } from '../adapter.js';
import type {
  SymbolSearchResult, CompanyProfile, Quote, OHLCVBar, Fundamentals,
  AnnualFinancials, QuarterlyFinancials, EarningsEvent, AnalystConsensus,
  DividendEvent, SplitEvent, SECFilingRef, InsiderTransaction,
  InstitutionalHolding, ShortInterest, OptionsSummary, MacroSnapshot, FxRate,
} from '../types.js';

const BASE = 'https://www.alphavantage.co/query';

function extractKey(ctx: ExecutionContext): string {
  const key = ctx.metadata?.['alphaVantageKey'] as string | undefined;
  if (!key) throw new Error('Alpha Vantage: set metadata.alphaVantageKey in execution context.');
  return key;
}

async function avFetch(params: Record<string, string>): Promise<Record<string, unknown>> {
  const url = new URL(BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
  const json = await res.json() as Record<string, unknown>;
  if (json['Note'] || json['Information']) throw new Error(`Alpha Vantage rate limit: ${JSON.stringify(json)}`);
  return json;
}

export function alphaVantageAdapter(): MarketDataAdapter {
  return {
    async searchSymbols(ctx, query): Promise<SymbolSearchResult[]> {
      const key = extractKey(ctx);
      const data = await avFetch({ function: 'SYMBOL_SEARCH', keywords: query, apikey: key });
      const matches = (data['bestMatches'] as Array<Record<string, string>> | undefined) ?? [];
      return matches.map(m => ({
        symbol: m['1. symbol'] ?? '', name: m['2. name'] ?? '',
        exchange: (m['4. region'] as SymbolSearchResult['exchange']) ?? 'OTHER',
        type: m['3. type'] ?? null, currency: m['8. currency'] ?? null,
      }));
    },

    async getProfile(ctx, symbol): Promise<CompanyProfile> {
      const key = extractKey(ctx);
      const data = await avFetch({ function: 'OVERVIEW', symbol, apikey: key });
      return {
        symbol, name: String(data['Name'] ?? symbol),
        exchange: (String(data['Exchange'] ?? 'OTHER')) as CompanyProfile['exchange'],
        sector: String(data['Sector'] ?? '') || null,
        industry: String(data['Industry'] ?? '') || null,
        country: String(data['Country'] ?? 'US'),
        currency: String(data['Currency'] ?? 'USD'),
        ipoDate: String(data['IPODate'] ?? '') || null,
        sharesOutstanding: data['SharesOutstanding'] ? Number(data['SharesOutstanding']) : null,
        description: String(data['Description'] ?? '') || null,
        website: null,
        fiscalYearEnd: String(data['FiscalYearEnd'] ?? '') || null,
      };
    },

    async getQuote(ctx, symbol): Promise<Quote> {
      const key = extractKey(ctx);
      const data = await avFetch({ function: 'GLOBAL_QUOTE', symbol, apikey: key });
      const q = (data['Global Quote'] as Record<string, string> | undefined) ?? {};
      return {
        symbol, price: Number(q['05. price']), currency: 'USD',
        ts: new Date().toISOString(),
        open: Number(q['02. open']) || null, high: Number(q['03. high']) || null,
        low: Number(q['04. low']) || null, previousClose: Number(q['08. previous close']) || null,
        change: Number(q['09. change']) || null, changePct: parseFloat(q['10. change percent'] ?? '0') / 100 || null,
        volume: Number(q['06. volume']) || null,
      };
    },

    async getOHLCV(ctx, symbol, params: OHLCVParams): Promise<OHLCVBar[]> {
      const key = extractKey(ctx);
      const fn = params.interval === 'daily' ? 'TIME_SERIES_DAILY_ADJUSTED' : params.interval === 'weekly' ? 'TIME_SERIES_WEEKLY_ADJUSTED' : 'TIME_SERIES_MONTHLY_ADJUSTED';
      const data = await avFetch({ function: fn, symbol, outputsize: 'full', apikey: key });
      const tsKey = Object.keys(data).find(k => k.includes('Time Series'));
      if (!tsKey) return [];
      const ts = data[tsKey] as Record<string, Record<string, string>>;
      return Object.entries(ts)
        .filter(([d]) => d >= params.from && d <= params.to)
        .map(([d, v]) => ({
          ts: `${d}T00:00:00Z`, open: Number(v['1. open']), high: Number(v['2. high']),
          low: Number(v['3. low']), close: Number(v['4. close']),
          adjustedClose: Number(v['5. adjusted close'] ?? v['4. close']),
          volume: Number(v['6. volume'] ?? v['5. volume']),
        }))
        .sort((a, b) => a.ts.localeCompare(b.ts));
    },

    async getFundamentals(ctx, symbol): Promise<Fundamentals> {
      const key = extractKey(ctx);
      const data = await avFetch({ function: 'OVERVIEW', symbol, apikey: key });
      const n = (field: string) => data[field] !== undefined && data[field] !== 'None' ? Number(data[field]) : null;
      return {
        symbol, asOf: new Date().toISOString().slice(0,10),
        fiscalConvention: 'US_GAAP', currency: String(data['Currency'] ?? 'USD'),
        marketCap: n('MarketCapitalization'), enterpriseValue: n('EVToEBITDA') !== null && n('EBITDA') !== null ? (n('EVToEBITDA')! * n('EBITDA')!) : null,
        peRatio: n('PERatio'), forwardPE: n('ForwardPE'), pegRatio: n('PEGRatio'),
        pbRatio: n('PriceToBookRatio'), psRatio: n('PriceToSalesRatioTTM'),
        evToEbitda: n('EVToEBITDA'), evToSales: n('EVToRevenue'),
        fcfYield: null, earningsYield: null,
        grossMargin: n('GrossProfitTTM') !== null && n('RevenueTTM') !== null ? (n('GrossProfitTTM')! / n('RevenueTTM')!) : null,
        operatingMargin: n('OperatingMarginTTM'), netMargin: n('ProfitMargin'),
        roe: n('ReturnOnEquityTTM'), roa: n('ReturnOnAssetsTTM'), roic: null, grossProfitToAssets: null,
        epsTtm: n('EPS'), dilutedEps: n('DilutedEPSTTM'), bookValuePerShare: n('BookValue'),
        fcfPerShare: null, dividendYield: n('DividendYield'), payoutRatio: n('PayoutRatio'),
        buybackYield: null, shareholderYield: null,
        debtToEquity: null, netDebtToEbitda: null, currentRatio: null, quickRatio: null,
        interestCoverage: null, altmanZScore: null, piotroskiFScore: null, beneishMScore: null,
        revenueGrowthYoy: n('QuarterlyRevenueGrowthYOY'), epsGrowthYoy: n('QuarterlyEarningsGrowthYOY'),
        fcfGrowthYoy: null, accrualsRatio: null, cfoToNetIncome: null,
      };
    },

    async getAnnualFinancials(_ctx, _symbol, _years): Promise<AnnualFinancials[]> { return []; },
    async getQuarterlyFinancials(_ctx, _symbol, _quarters): Promise<QuarterlyFinancials[]> { return []; },
    async getEarningsHistory(_ctx, _symbol, _quarters): Promise<EarningsEvent[]> { return []; },
    async getAnalystConsensus(ctx, symbol): Promise<AnalystConsensus> {
      return { symbol, asOf: new Date().toISOString().slice(0,10), buyCount: 0, holdCount: 0, sellCount: 0, meanTargetPrice: null, medianTargetPrice: null, epsRevisions30d: null, epsRevisions90d: null, consensusEps1y: null, consensusEps2y: null, consensusRevenue1y: null, longTermGrowthEstimate: null };
    },
    async getDividends(ctx, symbol, years): Promise<DividendEvent[]> {
      const key = extractKey(ctx);
      const data = await avFetch({ function: 'DIVIDENDS', symbol, apikey: key });
      const arr = (data['data'] as Array<Record<string,string>> | undefined) ?? [];
      const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - years);
      return arr.filter(d => d['ex_dividend_date'] && new Date(d['ex_dividend_date']) >= cutoff)
        .map(d => ({ exDate: d['ex_dividend_date'] ?? '', payDate: d['payment_date'] ?? null, amount: Number(d['amount']), currency: 'USD' }));
    },
    async getSplits(ctx, symbol): Promise<SplitEvent[]> {
      const key = extractKey(ctx);
      const data = await avFetch({ function: 'SPLITS', symbol, apikey: key });
      const arr = (data['data'] as Array<Record<string,string>> | undefined) ?? [];
      return arr.map(s => ({ exDate: s['effective_date'] ?? '', numerator: Number(s['split_factor']?.split('/')[0]), denominator: Number(s['split_factor']?.split('/')[1] ?? 1) }));
    },
    async getSECFilings(_ctx, _symbol, _formTypes): Promise<SECFilingRef[]> { return []; },
    async getInsiderTransactions(_ctx, _symbol, _days): Promise<InsiderTransaction[]> { return []; },
    async getInstitutionalHoldings(_ctx, _symbol): Promise<InstitutionalHolding[]> { return []; },
    async getShortInterest(_ctx, symbol): Promise<ShortInterest> {
      return { symbol, asOf: new Date().toISOString().slice(0,10), shortShares: 0, shortPctFloat: null, daysToCover: null, costToBorrow: null };
    },
    async getOptionsSummary(_ctx, _symbol): Promise<OptionsSummary | null> { return null; },
    async getMacroSnapshot(_ctx, region): Promise<MacroSnapshot> {
      return { asOf: new Date().toISOString().slice(0,10), region, policyRate: null, cpiYoy: null, gdpGrowthYoy: null, unemploymentRate: null, yieldCurve10y2y: null, vix: null };
    },
    async getFxRate(ctx, from, to): Promise<FxRate> {
      const key = extractKey(ctx);
      const data = await avFetch({ function: 'CURRENCY_EXCHANGE_RATE', from_currency: from, to_currency: to, apikey: key });
      const r = (data['Realtime Currency Exchange Rate'] as Record<string,string> | undefined) ?? {};
      return { from, to, rate: Number(r['5. Exchange Rate']), asOf: r['6. Last Refreshed'] ?? new Date().toISOString() };
    },
  };
}
