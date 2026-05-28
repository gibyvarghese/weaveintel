/**
 * Financial Modeling Prep (FMP) live adapter.
 * Key supplied via ctx.metadata.fmpKey.
 * FMP covers fundamentals, annual/quarterly financials, earnings history.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { MarketDataAdapter, OHLCVParams } from '../adapter.js';
import type {
  SymbolSearchResult, CompanyProfile, Quote, OHLCVBar, Fundamentals,
  AnnualFinancials, QuarterlyFinancials, EarningsEvent, AnalystConsensus,
  DividendEvent, SplitEvent, SECFilingRef, InsiderTransaction,
  InstitutionalHolding, ShortInterest, OptionsSummary, MacroSnapshot, FxRate,
} from '../types.js';

const BASE = 'https://financialmodelingprep.com/api/v3';

function extractKey(ctx: ExecutionContext): string {
  const key = ctx.metadata?.['fmpKey'] as string | undefined;
  if (!key) throw new Error('FMP: set metadata.fmpKey in execution context.');
  return key;
}

async function fmpGet(path: string, key: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('apikey', key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`FMP HTTP ${res.status}: ${path}`);
  return res.json();
}

export function fmpAdapter(): MarketDataAdapter {
  return {
    async searchSymbols(ctx, query): Promise<SymbolSearchResult[]> {
      const key = extractKey(ctx);
      const data = await fmpGet('/search', key, { query, limit: '10' }) as Array<Record<string,string>>;
      return (Array.isArray(data) ? data : []).map(r => ({
        symbol: r['symbol'] ?? '', name: r['name'] ?? '', exchange: (r['exchangeShortName'] ?? 'OTHER') as SymbolSearchResult['exchange'], type: 'equity', currency: r['currency'] ?? null,
      }));
    },

    async getProfile(ctx, symbol): Promise<CompanyProfile> {
      const key = extractKey(ctx);
      const data = await fmpGet(`/profile/${symbol}`, key) as Array<Record<string,unknown>>;
      const p = (Array.isArray(data) ? data[0] : {}) as Record<string,unknown>;
      return {
        symbol, name: String(p['companyName'] ?? symbol),
        exchange: (String(p['exchangeShortName'] ?? 'OTHER')) as CompanyProfile['exchange'],
        sector: String(p['sector'] ?? '') || null, industry: String(p['industry'] ?? '') || null,
        country: String(p['country'] ?? 'US'), currency: String(p['currency'] ?? 'USD'),
        ipoDate: String(p['ipoDate'] ?? '') || null,
        sharesOutstanding: p['sharesOutstanding'] ? Number(p['sharesOutstanding']) : null,
        description: String(p['description'] ?? '') || null,
        website: String(p['website'] ?? '') || null,
        fiscalYearEnd: null,
      };
    },

    async getQuote(ctx, symbol): Promise<Quote> {
      const key = extractKey(ctx);
      const data = await fmpGet(`/quote/${symbol}`, key) as Array<Record<string,unknown>>;
      const q = (Array.isArray(data) ? data[0] : {}) as Record<string,unknown>;
      return {
        symbol, price: Number(q['price'] ?? 0), currency: 'USD', ts: new Date().toISOString(),
        open: q['open'] !== undefined ? Number(q['open']) : null,
        high: q['dayHigh'] !== undefined ? Number(q['dayHigh']) : null,
        low: q['dayLow'] !== undefined ? Number(q['dayLow']) : null,
        previousClose: q['previousClose'] !== undefined ? Number(q['previousClose']) : null,
        change: q['change'] !== undefined ? Number(q['change']) : null,
        changePct: q['changesPercentage'] !== undefined ? Number(q['changesPercentage']) / 100 : null,
        volume: q['volume'] !== undefined ? Number(q['volume']) : null,
      };
    },

    async getOHLCV(ctx, symbol, params: OHLCVParams): Promise<OHLCVBar[]> {
      const key = extractKey(ctx);
      const path = params.interval === 'daily' ? `/historical-price-full/${symbol}` : `/historical-price-full/${symbol}`;
      const data = await fmpGet(path, key, { from: params.from, to: params.to }) as { historical?: Array<Record<string,unknown>> };
      return (data.historical ?? []).map(b => ({
        ts: `${b['date']}T00:00:00Z`, open: Number(b['open']), high: Number(b['high']),
        low: Number(b['low']), close: Number(b['close']),
        adjustedClose: Number(b['adjClose'] ?? b['close']),
        volume: Number(b['volume']),
      })).sort((a,b) => a.ts.localeCompare(b.ts));
    },

    async getFundamentals(ctx, symbol): Promise<Fundamentals> {
      const key = extractKey(ctx);
      const data = await fmpGet(`/ratios-ttm/${symbol}`, key) as Array<Record<string,unknown>>;
      const r = (Array.isArray(data) ? data[0] : {}) as Record<string, unknown>;
      const kd = await fmpGet(`/key-metrics-ttm/${symbol}`, key) as Array<Record<string,unknown>>;
      const k = (Array.isArray(kd) ? kd[0] : {}) as Record<string, unknown>;
      const n = (obj: Record<string,unknown>, field: string) => obj[field] !== undefined && obj[field] !== null ? Number(obj[field]) : null;
      return {
        symbol, asOf: new Date().toISOString().slice(0,10), fiscalConvention: 'US_GAAP', currency: 'USD',
        marketCap: n(k, 'marketCapTTM'), enterpriseValue: n(k, 'enterpriseValueTTM'),
        peRatio: n(r, 'peRatioTTM'), forwardPE: null, pegRatio: n(r, 'priceEarningsToGrowthRatioTTM'),
        pbRatio: n(r, 'priceToBookRatioTTM'), psRatio: n(r, 'priceToSalesRatioTTM'),
        evToEbitda: n(k, 'evToEbitdaTTM'), evToSales: n(k, 'enterpriseValueOverEBITDATTM'),
        fcfYield: n(r, 'freeCashFlowYieldTTM'), earningsYield: n(r, 'earningsYieldTTM'),
        grossMargin: n(r, 'grossProfitMarginTTM'), operatingMargin: n(r, 'operatingProfitMarginTTM'),
        netMargin: n(r, 'netProfitMarginTTM'), roe: n(r, 'returnOnEquityTTM'),
        roa: n(r, 'returnOnAssetsTTM'), roic: n(r, 'returnOnCapitalEmployedTTM'), grossProfitToAssets: null,
        epsTtm: n(k, 'netIncomePerShareTTM'), dilutedEps: null, bookValuePerShare: n(k, 'bookValuePerShareTTM'),
        fcfPerShare: n(k, 'freeCashFlowPerShareTTM'), dividendYield: n(r, 'dividendYieldPercentageTTM') !== null ? n(r, 'dividendYieldPercentageTTM')! / 100 : null,
        payoutRatio: n(r, 'payoutRatioTTM'), buybackYield: null, shareholderYield: null,
        debtToEquity: n(r, 'debtEquityRatioTTM'), netDebtToEbitda: n(k, 'netDebtToEBITDATTM'),
        currentRatio: n(r, 'currentRatioTTM'), quickRatio: n(r, 'quickRatioTTM'),
        interestCoverage: n(r, 'interestCoverageTTM'), altmanZScore: n(k, 'altmanZScoreTTM'),
        piotroskiFScore: n(k, 'piotroskiFScoreTTM'), beneishMScore: null,
        revenueGrowthYoy: n(k, 'revenueGrowthTTM'), epsGrowthYoy: null,
        fcfGrowthYoy: null, accrualsRatio: null, cfoToNetIncome: n(r, 'cashFlowToNetIncomeTTM'),
      };
    },

    async getAnnualFinancials(ctx, symbol, years): Promise<AnnualFinancials[]> {
      const key = extractKey(ctx);
      const inc = await fmpGet(`/income-statement/${symbol}`, key, { limit: String(years) }) as Array<Record<string,unknown>>;
      const cf  = await fmpGet(`/cash-flow-statement/${symbol}`, key, { limit: String(years) }) as Array<Record<string,unknown>>;
      const bs  = await fmpGet(`/balance-sheet-statement/${symbol}`, key, { limit: String(years) }) as Array<Record<string,unknown>>;
      const n = (obj: Record<string,unknown>, f: string) => obj[f] !== undefined && obj[f] !== null ? Number(obj[f]) : null;
      return (Array.isArray(inc) ? inc : []).map((row, i) => {
        const c = (cf[i] ?? {}) as Record<string,unknown>;
        const b = (bs[i] ?? {}) as Record<string,unknown>;
        const yr = parseInt(String(row['calendarYear'] ?? 2026));
        const cfo = n(c, 'operatingCashFlow');
        const capex = n(c, 'capitalExpenditure');
        return {
          fiscalYear: yr, periodEnd: String(row['date'] ?? `${yr}-12-31`), currency: String(row['reportedCurrency'] ?? 'USD'),
          revenue: n(row, 'revenue'), grossProfit: n(row, 'grossProfit'), operatingIncome: n(row, 'operatingIncome'),
          netIncome: n(row, 'netIncome'), ebitda: n(row, 'ebitda'), eps: n(row, 'eps'), cfo, capex,
          fcf: cfo !== null && capex !== null ? cfo + capex : null,
          totalAssets: n(b, 'totalAssets'), totalEquity: n(b, 'totalStockholdersEquity'),
          totalDebt: n(b, 'totalDebt'), sharesDilutedAvg: n(row, 'weightedAverageShsOutDil'),
          dividendsPaid: n(c, 'dividendsPaid'), buybacksDollar: n(c, 'commonStockRepurchased'),
          roeReported: null, roicReported: null,
        };
      });
    },

    async getQuarterlyFinancials(ctx, symbol, quarters): Promise<QuarterlyFinancials[]> {
      const key = extractKey(ctx);
      const data = await fmpGet(`/income-statement/${symbol}`, key, { period: 'quarter', limit: String(quarters) }) as Array<Record<string,unknown>>;
      const n = (obj: Record<string,unknown>, f: string) => obj[f] !== undefined && obj[f] !== null ? Number(obj[f]) : null;
      return (Array.isArray(data) ? data : []).map(row => {
        const yr = parseInt(String(row['calendarYear'] ?? 2026));
        const qtr = parseInt(String(row['period'] ?? 'Q4').replace('Q','')) as 1|2|3|4;
        return {
          fiscalYear: yr, fiscalQuarter: qtr, periodEnd: String(row['date'] ?? ''), currency: String(row['reportedCurrency'] ?? 'USD'),
          revenue: n(row, 'revenue'), grossProfit: n(row, 'grossProfit'), operatingIncome: n(row, 'operatingIncome'),
          netIncome: n(row, 'netIncome'), ebitda: n(row, 'ebitda'), eps: n(row, 'eps'), cfo: null, capex: null, fcf: null,
          totalAssets: null, totalEquity: null, totalDebt: null, sharesDilutedAvg: n(row, 'weightedAverageShsOutDil'),
          dividendsPaid: null, buybacksDollar: null, roeReported: null, roicReported: null,
        };
      });
    },

    async getEarningsHistory(ctx, symbol, quarters): Promise<EarningsEvent[]> {
      const key = extractKey(ctx);
      const data = await fmpGet(`/earnings-surpises/${symbol}`, key) as Array<Record<string,unknown>>;
      return (Array.isArray(data) ? data : []).slice(0, quarters).map(e => ({
        fiscalPeriod: String(e['date'] ?? ''), reportDate: String(e['date'] ?? ''),
        epsEstimate: e['estimatedEps'] !== null ? Number(e['estimatedEps']) : null,
        epsActual: e['actualEarningResult'] !== null ? Number(e['actualEarningResult']) : null,
        surprisePct: null, revenueEstimate: null, revenueActual: null, revenueSurprisePct: null, guidanceTone: null,
      }));
    },

    async getAnalystConsensus(ctx, symbol): Promise<AnalystConsensus> {
      const key = extractKey(ctx);
      const data = await fmpGet(`/analyst-stock-recommendations/${symbol}`, key) as Array<Record<string,unknown>>;
      const latest = Array.isArray(data) && data.length > 0 ? data[0]! : {};
      return {
        symbol, asOf: String(latest['date'] ?? new Date().toISOString().slice(0,10)),
        buyCount: Number(latest['analystRatingsbuy'] ?? 0) + Number(latest['analystRatingsStrongBuy'] ?? 0),
        holdCount: Number(latest['analystRatingsHold'] ?? 0),
        sellCount: Number(latest['analystRatingsSell'] ?? 0) + Number(latest['analystRatingsStrongSell'] ?? 0),
        meanTargetPrice: null, medianTargetPrice: null, epsRevisions30d: null, epsRevisions90d: null,
        consensusEps1y: null, consensusEps2y: null, consensusRevenue1y: null, longTermGrowthEstimate: null,
      };
    },

    async getDividends(ctx, symbol, years): Promise<DividendEvent[]> {
      const key = extractKey(ctx);
      const data = await fmpGet(`/historical/stock_dividend/${symbol}`, key) as { historical?: Array<Record<string,unknown>> };
      const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - years);
      return (data.historical ?? [])
        .filter(d => d['date'] && new Date(String(d['date'])) >= cutoff)
        .map(d => ({ exDate: String(d['date'] ?? ''), payDate: String(d['paymentDate'] ?? '') || null, amount: Number(d['adjDividend'] ?? d['dividend']), currency: 'USD' }));
    },

    async getSplits(ctx, symbol): Promise<SplitEvent[]> {
      const key = extractKey(ctx);
      const data = await fmpGet(`/historical/stock_split/${symbol}`, key) as { historical?: Array<Record<string,unknown>> };
      return (data.historical ?? []).map(s => ({
        exDate: String(s['date'] ?? ''), numerator: Number(s['numerator']), denominator: Number(s['denominator']),
      }));
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
      const pair = `${from}${to}`;
      const data = await fmpGet(`/fx/${pair}`, key) as Array<Record<string,unknown>>;
      const row = (Array.isArray(data) ? data[0] : {}) as Record<string,unknown>;
      return { from, to, rate: Number(row['price'] ?? 1), asOf: new Date().toISOString() };
    },
  };
}
