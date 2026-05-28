/**
 * Finnhub live adapter.
 * Key supplied via ctx.metadata.finnhubKey.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { MarketDataAdapter, OHLCVParams } from '../adapter.js';
import type {
  SymbolSearchResult, CompanyProfile, Quote, OHLCVBar, Fundamentals,
  AnnualFinancials, QuarterlyFinancials, EarningsEvent, AnalystConsensus,
  DividendEvent, SplitEvent, SECFilingRef, InsiderTransaction,
  InstitutionalHolding, ShortInterest, OptionsSummary, MacroSnapshot, FxRate,
} from '../types.js';

const BASE = 'https://finnhub.io/api/v1';

function extractKey(ctx: ExecutionContext): string {
  const key = ctx.metadata?.['finnhubKey'] as string | undefined;
  if (!key) throw new Error('Finnhub: set metadata.finnhubKey in execution context.');
  return key;
}

async function fhGet(path: string, key: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('token', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}: ${path}`);
  return res.json();
}

export function finnhubAdapter(): MarketDataAdapter {
  return {
    async searchSymbols(ctx, query): Promise<SymbolSearchResult[]> {
      const key = extractKey(ctx);
      const data = await fhGet('/search', key, { q: query }) as { result?: Array<{ symbol: string; description: string; type: string; displaySymbol: string }> };
      return (data.result ?? []).slice(0, 10).map(r => ({
        symbol: r.symbol, name: r.description, exchange: 'OTHER' as SymbolSearchResult['exchange'], type: r.type, currency: null,
      }));
    },

    async getProfile(ctx, symbol): Promise<CompanyProfile> {
      const key = extractKey(ctx);
      const data = await fhGet('/stock/profile2', key, { symbol }) as Record<string, unknown>;
      return {
        symbol, name: String(data['name'] ?? symbol),
        exchange: (String(data['exchange'] ?? 'OTHER')) as CompanyProfile['exchange'],
        sector: String(data['finnhubIndustry'] ?? '') || null,
        industry: String(data['finnhubIndustry'] ?? '') || null,
        country: String(data['country'] ?? 'US'),
        currency: String(data['currency'] ?? 'USD'),
        ipoDate: String(data['ipo'] ?? '') || null,
        sharesOutstanding: data['shareOutstanding'] ? Number(data['shareOutstanding']) * 1e6 : null,
        description: null,
        website: String(data['weburl'] ?? '') || null,
        fiscalYearEnd: null,
      };
    },

    async getQuote(ctx, symbol): Promise<Quote> {
      const key = extractKey(ctx);
      const data = await fhGet('/quote', key, { symbol }) as Record<string, number>;
      return {
        symbol, price: data['c'] ?? 0, currency: 'USD', ts: new Date((data['t'] ?? 0) * 1000).toISOString(),
        open: data['o'] ?? null, high: data['h'] ?? null, low: data['l'] ?? null,
        previousClose: data['pc'] ?? null, change: data['d'] ?? null, changePct: (data['dp'] ?? null) !== null ? (data['dp']! / 100) : null, volume: null,
      };
    },

    async getOHLCV(ctx, symbol, params: OHLCVParams): Promise<OHLCVBar[]> {
      const key = extractKey(ctx);
      const res = params.interval === 'daily' ? 'D' : params.interval === 'weekly' ? 'W' : 'M';
      const from = Math.floor(new Date(params.from).getTime() / 1000);
      const to   = Math.floor(new Date(params.to).getTime() / 1000);
      const data = await fhGet('/stock/candle', key, { symbol, resolution: res, from: String(from), to: String(to) }) as Record<string, unknown>;
      if (data['s'] !== 'ok') return [];
      const ts = data['t'] as number[], c = data['c'] as number[], o = data['o'] as number[], h = data['h'] as number[], l = data['l'] as number[], v = data['v'] as number[];
      return ts.map((t, i) => ({
        ts: new Date(t * 1000).toISOString(), open: o[i]!, high: h[i]!, low: l[i]!, close: c[i]!,
        adjustedClose: c[i]!, volume: v[i]!,
      }));
    },

    async getFundamentals(ctx, symbol): Promise<Fundamentals> {
      const key = extractKey(ctx);
      const data = await fhGet('/stock/metric', key, { symbol, metric: 'all' }) as { metric?: Record<string, unknown> };
      const m = data.metric ?? {};
      const n = (k: string) => m[k] !== undefined && m[k] !== null ? Number(m[k]) : null;
      return {
        symbol, asOf: new Date().toISOString().slice(0,10), fiscalConvention: 'US_GAAP', currency: 'USD',
        marketCap: n('marketCapitalization') !== null ? n('marketCapitalization')! * 1e6 : null,
        enterpriseValue: null, peRatio: n('peNormalizedAnnual'), forwardPE: n('peExclExtraTTM'),
        pegRatio: null, pbRatio: n('pbAnnual'), psRatio: n('psTTM'), evToEbitda: n('currentEv/freeCashFlowAnnual'),
        evToSales: null, fcfYield: null, earningsYield: null,
        grossMargin: n('grossMarginAnnual'), operatingMargin: n('operatingMarginAnnual'), netMargin: n('netProfitMarginAnnual'),
        roe: n('roeRfy'), roa: n('roaRfy'), roic: n('roicAnnual'), grossProfitToAssets: null,
        epsTtm: n('epsTTM'), dilutedEps: n('epsBasicExclExtraItemsAnnual'), bookValuePerShare: n('bookValuePerShareAnnual'),
        fcfPerShare: n('freeCashFlowPerShareAnnual'), dividendYield: n('dividendYieldIndicatedAnnual'),
        payoutRatio: n('payoutRatioAnnual'), buybackYield: null, shareholderYield: null,
        debtToEquity: n('totalDebt/totalEquityAnnual'), netDebtToEbitda: null,
        currentRatio: n('currentRatioAnnual'), quickRatio: n('quickRatioAnnual'), interestCoverage: null,
        altmanZScore: null, piotroskiFScore: null, beneishMScore: null,
        revenueGrowthYoy: n('revenueGrowthQuarterlyYoy'), epsGrowthYoy: n('epsGrowth3Y'),
        fcfGrowthYoy: null, accrualsRatio: null, cfoToNetIncome: null,
      };
    },

    async getAnnualFinancials(_ctx, _symbol, _years): Promise<AnnualFinancials[]> { return []; },
    async getQuarterlyFinancials(_ctx, _symbol, _quarters): Promise<QuarterlyFinancials[]> { return []; },

    async getEarningsHistory(ctx, symbol, quarters): Promise<EarningsEvent[]> {
      const key = extractKey(ctx);
      const data = await fhGet('/stock/earnings', key, { symbol }) as { earningsCalendar?: Array<Record<string,unknown>> };
      return (data.earningsCalendar ?? []).slice(0, quarters).map(e => ({
        fiscalPeriod: String(e['period'] ?? ''), reportDate: String(e['date'] ?? ''),
        epsEstimate: e['epsEstimate'] !== null ? Number(e['epsEstimate']) : null,
        epsActual: e['epsActual'] !== null ? Number(e['epsActual']) : null,
        surprisePct: e['epsEstimate'] && e['epsActual'] ? ((Number(e['epsActual']) - Number(e['epsEstimate'])) / Math.abs(Number(e['epsEstimate']))) * 100 : null,
        revenueEstimate: e['revenueEstimate'] !== null ? Number(e['revenueEstimate']) : null,
        revenueActual: e['revenueActual'] !== null ? Number(e['revenueActual']) : null,
        revenueSurprisePct: null, guidanceTone: null,
      }));
    },

    async getAnalystConsensus(ctx, symbol): Promise<AnalystConsensus> {
      const key = extractKey(ctx);
      const data = await fhGet('/stock/recommendation', key, { symbol }) as Array<Record<string, unknown>>;
      const latest = Array.isArray(data) ? data[0] : undefined;
      return {
        symbol, asOf: String(latest?.['period'] ?? new Date().toISOString().slice(0,10)),
        buyCount: Number(latest?.['buy'] ?? 0) + Number(latest?.['strongBuy'] ?? 0),
        holdCount: Number(latest?.['hold'] ?? 0),
        sellCount: Number(latest?.['sell'] ?? 0) + Number(latest?.['strongSell'] ?? 0),
        meanTargetPrice: null, medianTargetPrice: null, epsRevisions30d: null, epsRevisions90d: null,
        consensusEps1y: null, consensusEps2y: null, consensusRevenue1y: null, longTermGrowthEstimate: null,
      };
    },

    async getDividends(_ctx, _symbol, _years): Promise<DividendEvent[]> { return []; },
    async getSplits(_ctx, _symbol, _years): Promise<SplitEvent[]> { return []; },
    async getSECFilings(_ctx, _symbol, _formTypes): Promise<SECFilingRef[]> { return []; },

    async getInsiderTransactions(ctx, symbol, days): Promise<InsiderTransaction[]> {
      const key = extractKey(ctx);
      const to = new Date().toISOString().slice(0,10);
      const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0,10);
      const data = await fhGet('/stock/insider-transactions', key, { symbol, from, to }) as { data?: Array<Record<string,unknown>> };
      return (data.data ?? []).map(t => ({
        symbol, insiderName: String(t['name'] ?? ''), insiderTitle: String(t['position'] ?? '') || null,
        transactionDate: String(t['transactionDate'] ?? ''),
        transactionCode: (String(t['transactionCode'] ?? 'OTHER')) as InsiderTransaction['transactionCode'],
        shares: Math.abs(Number(t['share'] ?? 0)), pricePerShare: t['price'] ? Number(t['price']) : null,
        valueUsd: t['value'] ? Number(t['value']) : null, sharesOwnedAfter: null,
      }));
    },

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
      const data = await fhGet('/forex/rates', key, { base: from }) as { quote?: Record<string, number> };
      const rate = data.quote?.[to];
      if (!rate) throw new Error(`Finnhub: FX rate ${from}/${to} not found`);
      return { from, to, rate, asOf: new Date().toISOString() };
    },
  };
}
