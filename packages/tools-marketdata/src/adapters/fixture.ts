/**
 * Deterministic in-memory fixture adapter for tests and offline demos.
 * Covers 5 US tickers (AAPL, MSFT, GOOGL, JNJ, XOM) and
 * 3 NSE tickers (RELIANCE, TCS, INFY). Multi-year history is synthetic
 * but internally consistent (growth rates, ratios derived from base data).
 * No network calls — safe for CI.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { MarketDataAdapter, OHLCVParams } from '../adapter.js';
import type {
  SymbolSearchResult, CompanyProfile, Quote, OHLCVBar, Fundamentals,
  AnnualFinancials, QuarterlyFinancials, EarningsEvent, AnalystConsensus,
  DividendEvent, SplitEvent, SECFilingRef, InsiderTransaction,
  InstitutionalHolding, ShortInterest, OptionsSummary, MacroSnapshot, FxRate,
} from '../types.js';

// ── Fixture database ─────────────────────────────────────────────────────────

const PROFILES: Record<string, CompanyProfile> = {
  AAPL:     { symbol: 'AAPL',     name: 'Apple Inc.',              exchange: 'NASDAQ', sector: 'Information Technology', industry: 'Technology Hardware',     country: 'US', currency: 'USD', ipoDate: '1980-12-12', sharesOutstanding: 15_441_000_000, description: 'Apple designs and sells consumer electronics.', website: 'https://apple.com', fiscalYearEnd: '09-30' },
  MSFT:     { symbol: 'MSFT',     name: 'Microsoft Corporation',   exchange: 'NASDAQ', sector: 'Information Technology', industry: 'Systems Software',         country: 'US', currency: 'USD', ipoDate: '1986-03-13', sharesOutstanding: 7_432_000_000,  description: 'Microsoft develops software and cloud services.', website: 'https://microsoft.com', fiscalYearEnd: '06-30' },
  GOOGL:    { symbol: 'GOOGL',    name: 'Alphabet Inc.',           exchange: 'NASDAQ', sector: 'Communication Services',  industry: 'Interactive Media',       country: 'US', currency: 'USD', ipoDate: '2004-08-19', sharesOutstanding: 12_250_000_000, description: 'Alphabet is the parent of Google.', website: 'https://abc.xyz', fiscalYearEnd: '12-31' },
  JNJ:      { symbol: 'JNJ',      name: 'Johnson & Johnson',       exchange: 'NYSE',   sector: 'Health Care',            industry: 'Pharmaceuticals',          country: 'US', currency: 'USD', ipoDate: '1944-09-25', sharesOutstanding: 2_600_000_000,  description: 'J&J is a diversified healthcare company.', website: 'https://jnj.com', fiscalYearEnd: '12-31' },
  XOM:      { symbol: 'XOM',      name: 'Exxon Mobil Corporation', exchange: 'NYSE',   sector: 'Energy',                 industry: 'Integrated Oil & Gas',     country: 'US', currency: 'USD', ipoDate: '1920-01-01', sharesOutstanding: 4_000_000_000,  description: 'ExxonMobil explores and produces oil and gas.', website: 'https://exxonmobil.com', fiscalYearEnd: '12-31' },
  RELIANCE: { symbol: 'RELIANCE', name: 'Reliance Industries Ltd', exchange: 'NSE',    sector: 'Energy',                 industry: 'Oil & Gas Refining',       country: 'IN', currency: 'INR', ipoDate: '1977-11-15', sharesOutstanding: 6_770_000_000,  description: 'Reliance operates in petrochemicals, telecom, and retail.', website: 'https://ril.com', fiscalYearEnd: '03-31' },
  TCS:      { symbol: 'TCS',      name: 'Tata Consultancy Services', exchange: 'NSE',  sector: 'Information Technology', industry: 'IT Services & Consulting', country: 'IN', currency: 'INR', ipoDate: '2004-08-25', sharesOutstanding: 3_620_000_000,  description: 'TCS is a global IT services company.', website: 'https://tcs.com', fiscalYearEnd: '03-31' },
  INFY:     { symbol: 'INFY',     name: 'Infosys Limited',         exchange: 'NSE',    sector: 'Information Technology', industry: 'IT Services & Consulting', country: 'IN', currency: 'INR', ipoDate: '1993-02-08', sharesOutstanding: 4_150_000_000,  description: 'Infosys is a digital services and consulting firm.', website: 'https://infosys.com', fiscalYearEnd: '03-31' },
};

const QUOTES: Record<string, Quote> = {
  AAPL:     { symbol: 'AAPL',     price: 189.30, currency: 'USD', ts: '2026-05-29T20:00:00Z', open: 187.50, high: 190.20, low: 186.90, previousClose: 187.10, change: 2.20, changePct: 1.18, volume: 58_200_000 },
  MSFT:     { symbol: 'MSFT',     price: 415.20, currency: 'USD', ts: '2026-05-29T20:00:00Z', open: 412.00, high: 418.50, low: 411.20, previousClose: 411.80, change: 3.40, changePct: 0.83, volume: 22_100_000 },
  GOOGL:    { symbol: 'GOOGL',    price: 172.40, currency: 'USD', ts: '2026-05-29T20:00:00Z', open: 170.00, high: 173.80, low: 169.50, previousClose: 170.10, change: 2.30, changePct: 1.35, volume: 25_400_000 },
  JNJ:      { symbol: 'JNJ',      price: 155.80, currency: 'USD', ts: '2026-05-29T20:00:00Z', open: 155.00, high: 156.90, low: 154.50, previousClose: 155.10, change: 0.70, changePct: 0.45, volume: 8_300_000 },
  XOM:      { symbol: 'XOM',      price: 112.50, currency: 'USD', ts: '2026-05-29T20:00:00Z', open: 111.20, high: 113.40, low: 110.80, previousClose: 111.50, change: 1.00, changePct: 0.90, volume: 19_600_000 },
  RELIANCE: { symbol: 'RELIANCE', price: 2985.00, currency: 'INR', ts: '2026-05-29T10:30:00Z', open: 2960.00, high: 3010.00, low: 2950.00, previousClose: 2958.00, change: 27.00, changePct: 0.91, volume: 8_400_000 },
  TCS:      { symbol: 'TCS',      price: 3820.00, currency: 'INR', ts: '2026-05-29T10:30:00Z', open: 3800.00, high: 3845.00, low: 3795.00, previousClose: 3802.00, change: 18.00, changePct: 0.47, volume: 2_200_000 },
  INFY:     { symbol: 'INFY',     price: 1620.00, currency: 'INR', ts: '2026-05-29T10:30:00Z', open: 1608.00, high: 1632.00, low: 1605.00, previousClose: 1609.00, change: 11.00, changePct: 0.68, volume: 5_100_000 },
};

function makeFundamentals(sym: string, data: Partial<Fundamentals>): Fundamentals {
  const base: Fundamentals = {
    symbol: sym, asOf: '2026-03-31', fiscalConvention: 'US_GAAP', currency: 'USD',
    marketCap: null, enterpriseValue: null, peRatio: null, forwardPE: null, pegRatio: null,
    pbRatio: null, psRatio: null, evToEbitda: null, evToSales: null, fcfYield: null, earningsYield: null,
    grossMargin: null, operatingMargin: null, netMargin: null, roe: null, roa: null, roic: null, grossProfitToAssets: null,
    epsTtm: null, dilutedEps: null, bookValuePerShare: null, fcfPerShare: null,
    dividendYield: null, payoutRatio: null, buybackYield: null, shareholderYield: null,
    debtToEquity: null, netDebtToEbitda: null, currentRatio: null, quickRatio: null,
    interestCoverage: null, altmanZScore: null, piotroskiFScore: null, beneishMScore: null,
    revenueGrowthYoy: null, epsGrowthYoy: null, fcfGrowthYoy: null, accrualsRatio: null, cfoToNetIncome: null,
  };
  return { ...base, ...data };
}

const FUNDAMENTALS: Record<string, Fundamentals> = {
  AAPL:  makeFundamentals('AAPL',  { currency: 'USD', fiscalConvention: 'US_GAAP', marketCap: 2_920_000_000_000, enterpriseValue: 2_980_000_000_000, peRatio: 29.8, forwardPE: 27.5, pegRatio: 2.1, pbRatio: 49.2, psRatio: 7.6, evToEbitda: 22.1, evToSales: 7.8, fcfYield: 0.038, earningsYield: 0.034, grossMargin: 0.455, operatingMargin: 0.305, netMargin: 0.256, roe: 1.62, roa: 0.32, roic: 0.55, grossProfitToAssets: 0.41, epsTtm: 6.35, dilutedEps: 6.35, bookValuePerShare: 3.85, fcfPerShare: 7.20, dividendYield: 0.005, payoutRatio: 0.15, buybackYield: 0.037, shareholderYield: 0.042, debtToEquity: 2.0, netDebtToEbitda: 0.4, currentRatio: 1.04, quickRatio: 0.98, interestCoverage: 28.5, altmanZScore: 6.8, piotroskiFScore: 7, beneishMScore: -2.9, revenueGrowthYoy: 0.061, epsGrowthYoy: 0.115, fcfGrowthYoy: 0.092, accrualsRatio: -0.02, cfoToNetIncome: 1.15 }),
  MSFT:  makeFundamentals('MSFT',  { currency: 'USD', fiscalConvention: 'US_GAAP', marketCap: 3_085_000_000_000, enterpriseValue: 3_110_000_000_000, peRatio: 33.5, forwardPE: 29.8, pegRatio: 1.9, pbRatio: 12.8, psRatio: 13.2, evToEbitda: 24.8, evToSales: 13.3, fcfYield: 0.029, earningsYield: 0.030, grossMargin: 0.690, operatingMargin: 0.440, netMargin: 0.355, roe: 0.38, roa: 0.19, roic: 0.28, grossProfitToAssets: 0.35, epsTtm: 12.40, dilutedEps: 12.40, bookValuePerShare: 32.50, fcfPerShare: 12.00, dividendYield: 0.007, payoutRatio: 0.24, buybackYield: 0.012, shareholderYield: 0.019, debtToEquity: 0.4, netDebtToEbitda: 0.2, currentRatio: 1.35, quickRatio: 1.28, interestCoverage: 42.0, altmanZScore: 8.5, piotroskiFScore: 8, beneishMScore: -3.1, revenueGrowthYoy: 0.155, epsGrowthYoy: 0.21, fcfGrowthYoy: 0.18, accrualsRatio: -0.03, cfoToNetIncome: 1.22 }),
  GOOGL: makeFundamentals('GOOGL', { currency: 'USD', fiscalConvention: 'US_GAAP', marketCap: 2_112_000_000_000, enterpriseValue: 2_050_000_000_000, peRatio: 21.5, forwardPE: 19.2, pegRatio: 1.1, pbRatio: 6.4, psRatio: 5.9, evToEbitda: 14.2, evToSales: 5.7, fcfYield: 0.048, earningsYield: 0.047, grossMargin: 0.578, operatingMargin: 0.312, netMargin: 0.258, roe: 0.30, roa: 0.20, roic: 0.27, grossProfitToAssets: 0.30, epsTtm: 8.02, dilutedEps: 8.02, bookValuePerShare: 26.9, fcfPerShare: 8.28, dividendYield: 0.005, payoutRatio: 0.10, buybackYield: 0.028, shareholderYield: 0.033, debtToEquity: 0.1, netDebtToEbitda: -0.5, currentRatio: 2.0, quickRatio: 1.95, interestCoverage: 65.0, altmanZScore: 11.2, piotroskiFScore: 8, beneishMScore: -3.0, revenueGrowthYoy: 0.121, epsGrowthYoy: 0.35, fcfGrowthYoy: 0.28, accrualsRatio: -0.01, cfoToNetIncome: 1.30 }),
  JNJ:   makeFundamentals('JNJ',   { currency: 'USD', fiscalConvention: 'US_GAAP', marketCap: 405_000_000_000, enterpriseValue: 425_000_000_000, peRatio: 16.2, forwardPE: 15.0, pegRatio: 2.8, pbRatio: 5.8, psRatio: 3.6, evToEbitda: 12.1, evToSales: 3.8, fcfYield: 0.048, earningsYield: 0.062, grossMargin: 0.685, operatingMargin: 0.235, netMargin: 0.182, roe: 0.22, roa: 0.10, roic: 0.17, grossProfitToAssets: 0.32, epsTtm: 9.62, dilutedEps: 9.62, bookValuePerShare: 26.8, fcfPerShare: 7.48, dividendYield: 0.031, payoutRatio: 0.48, buybackYield: 0.012, shareholderYield: 0.043, debtToEquity: 0.55, netDebtToEbitda: 1.2, currentRatio: 1.40, quickRatio: 1.10, interestCoverage: 18.5, altmanZScore: 5.2, piotroskiFScore: 7, beneishMScore: -2.7, revenueGrowthYoy: 0.052, epsGrowthYoy: 0.068, fcfGrowthYoy: 0.055, accrualsRatio: 0.01, cfoToNetIncome: 1.08 }),
  XOM:   makeFundamentals('XOM',   { currency: 'USD', fiscalConvention: 'US_GAAP', marketCap: 450_000_000_000, enterpriseValue: 510_000_000_000, peRatio: 13.8, forwardPE: 12.5, pegRatio: 3.2, pbRatio: 2.1, psRatio: 1.2, evToEbitda: 8.2, evToSales: 1.4, fcfYield: 0.052, earningsYield: 0.072, grossMargin: 0.38, operatingMargin: 0.155, netMargin: 0.107, roe: 0.15, roa: 0.08, roic: 0.12, grossProfitToAssets: 0.18, epsTtm: 8.15, dilutedEps: 8.15, bookValuePerShare: 53.6, fcfPerShare: 5.85, dividendYield: 0.034, payoutRatio: 0.47, buybackYield: 0.028, shareholderYield: 0.062, debtToEquity: 0.22, netDebtToEbitda: 0.8, currentRatio: 1.52, quickRatio: 1.25, interestCoverage: 22.0, altmanZScore: 4.1, piotroskiFScore: 6, beneishMScore: -2.4, revenueGrowthYoy: -0.03, epsGrowthYoy: -0.15, fcfGrowthYoy: -0.08, accrualsRatio: 0.02, cfoToNetIncome: 1.35 }),
  RELIANCE: makeFundamentals('RELIANCE', { currency: 'INR', fiscalConvention: 'IND_AS', marketCap: 20_210_000_000_000, enterpriseValue: 24_100_000_000_000, peRatio: 27.2, forwardPE: 23.5, pegRatio: 1.8, pbRatio: 2.35, psRatio: 1.62, evToEbitda: 13.5, evToSales: 1.7, fcfYield: 0.025, earningsYield: 0.037, grossMargin: 0.24, operatingMargin: 0.128, netMargin: 0.097, roe: 0.087, roa: 0.045, roic: 0.082, grossProfitToAssets: 0.14, epsTtm: 109.8, dilutedEps: 109.8, bookValuePerShare: 1270.0, fcfPerShare: 74.6, dividendYield: 0.003, payoutRatio: 0.08, buybackYield: 0.004, shareholderYield: 0.007, debtToEquity: 0.35, netDebtToEbitda: 1.8, currentRatio: 1.22, quickRatio: 0.95, interestCoverage: 8.5, altmanZScore: 3.8, piotroskiFScore: 6, beneishMScore: -2.2, revenueGrowthYoy: 0.072, epsGrowthYoy: 0.085, fcfGrowthYoy: 0.11, accrualsRatio: 0.03, cfoToNetIncome: 0.95 }),
  TCS:   makeFundamentals('TCS',   { currency: 'INR', fiscalConvention: 'IND_AS', marketCap: 13_825_000_000_000, enterpriseValue: 13_610_000_000_000, peRatio: 24.8, forwardPE: 22.5, pegRatio: 2.5, pbRatio: 12.2, psRatio: 5.5, evToEbitda: 18.2, evToSales: 5.4, fcfYield: 0.038, earningsYield: 0.040, grossMargin: 0.33, operatingMargin: 0.245, netMargin: 0.188, roe: 0.51, roa: 0.30, roic: 0.48, grossProfitToAssets: 0.28, epsTtm: 154.0, dilutedEps: 154.0, bookValuePerShare: 313.0, fcfPerShare: 145.0, dividendYield: 0.015, payoutRatio: 0.38, buybackYield: 0.012, shareholderYield: 0.027, debtToEquity: 0.04, netDebtToEbitda: -0.3, currentRatio: 2.35, quickRatio: 2.30, interestCoverage: 85.0, altmanZScore: 9.8, piotroskiFScore: 9, beneishMScore: -3.5, revenueGrowthYoy: 0.062, epsGrowthYoy: 0.089, fcfGrowthYoy: 0.095, accrualsRatio: -0.02, cfoToNetIncome: 1.10 }),
  INFY:  makeFundamentals('INFY',  { currency: 'INR', fiscalConvention: 'IND_AS', marketCap: 6_723_000_000_000, enterpriseValue: 6_510_000_000_000, peRatio: 22.5, forwardPE: 20.8, pegRatio: 2.2, pbRatio: 8.6, psRatio: 4.2, evToEbitda: 15.8, evToSales: 4.1, fcfYield: 0.042, earningsYield: 0.044, grossMargin: 0.32, operatingMargin: 0.218, netMargin: 0.171, roe: 0.38, roa: 0.22, roic: 0.36, grossProfitToAssets: 0.25, epsTtm: 72.0, dilutedEps: 72.0, bookValuePerShare: 188.0, fcfPerShare: 68.0, dividendYield: 0.018, payoutRatio: 0.42, buybackYield: 0.008, shareholderYield: 0.026, debtToEquity: 0.03, netDebtToEbitda: -0.2, currentRatio: 2.10, quickRatio: 2.05, interestCoverage: 72.0, altmanZScore: 9.2, piotroskiFScore: 8, beneishMScore: -3.2, revenueGrowthYoy: 0.048, epsGrowthYoy: 0.068, fcfGrowthYoy: 0.075, accrualsRatio: -0.01, cfoToNetIncome: 1.08 }),
};

// Generate synthetic annual financials (10 years) from base fundamentals.
function makeAnnualFinancials(sym: string, base: { revenue: number; netIncome: number; roic: number; revenueGrowth: number; currency: string; fiscalEnd: number }): AnnualFinancials[] {
  const rows: AnnualFinancials[] = [];
  let revenue = base.revenue;
  let netIncome = base.netIncome;
  for (let i = 0; i < 10; i++) {
    const yr = 2026 - i;
    const gr = base.revenueGrowth - i * 0.005;
    const grossProfit = revenue * 0.40;
    const ebitda = revenue * 0.25;
    const cfo = netIncome * 1.15;
    const capex = revenue * 0.05;
    rows.push({
      fiscalYear: yr, periodEnd: `${yr}-${String(base.fiscalEnd).padStart(2,'0')}-30`,
      currency: base.currency,
      revenue: Math.round(revenue), grossProfit: Math.round(grossProfit),
      operatingIncome: Math.round(revenue * 0.22), netIncome: Math.round(netIncome),
      ebitda: Math.round(ebitda), eps: Math.round((netIncome / 1e9) * 100) / 100,
      cfo: Math.round(cfo), capex: Math.round(capex), fcf: Math.round(cfo - capex),
      totalAssets: Math.round(revenue * 1.8), totalEquity: Math.round(revenue * 0.6),
      totalDebt: Math.round(revenue * 0.25), sharesDilutedAvg: 7_500_000_000,
      dividendsPaid: Math.round(netIncome * 0.1), buybacksDollar: Math.round(netIncome * 0.3),
      roeReported: base.roic * 1.2, roicReported: base.roic,
    });
    revenue = revenue / (1 + Math.max(0.01, gr));
    netIncome = netIncome / (1 + Math.max(0.01, gr - 0.01));
  }
  return rows;
}

const ANNUAL_FINANCIALS: Record<string, AnnualFinancials[]> = {
  AAPL:     makeAnnualFinancials('AAPL',     { revenue: 395_000_000_000, netIncome: 100_000_000_000, roic: 0.55, revenueGrowth: 0.07,  currency: 'USD', fiscalEnd: 9 }),
  MSFT:     makeAnnualFinancials('MSFT',     { revenue: 245_000_000_000, netIncome: 87_000_000_000,  roic: 0.28, revenueGrowth: 0.16,  currency: 'USD', fiscalEnd: 6 }),
  GOOGL:    makeAnnualFinancials('GOOGL',    { revenue: 358_000_000_000, netIncome: 92_000_000_000,  roic: 0.27, revenueGrowth: 0.12,  currency: 'USD', fiscalEnd: 12 }),
  JNJ:      makeAnnualFinancials('JNJ',      { revenue: 112_000_000_000, netIncome: 20_400_000_000,  roic: 0.17, revenueGrowth: 0.055, currency: 'USD', fiscalEnd: 12 }),
  XOM:      makeAnnualFinancials('XOM',      { revenue: 398_000_000_000, netIncome: 32_600_000_000,  roic: 0.12, revenueGrowth: 0.02,  currency: 'USD', fiscalEnd: 12 }),
  RELIANCE: makeAnnualFinancials('RELIANCE', { revenue: 9_720_000_000_000, netIncome: 944_000_000_000, roic: 0.082, revenueGrowth: 0.075, currency: 'INR', fiscalEnd: 3 }),
  TCS:      makeAnnualFinancials('TCS',      { revenue: 2_408_000_000_000, netIncome: 452_000_000_000, roic: 0.48, revenueGrowth: 0.062, currency: 'INR', fiscalEnd: 3 }),
  INFY:     makeAnnualFinancials('INFY',     { revenue: 1_575_000_000_000, netIncome: 270_000_000_000, roic: 0.36, revenueGrowth: 0.048, currency: 'INR', fiscalEnd: 3 }),
};

function makeQuarterly(sym: string, annual: AnnualFinancials[]): QuarterlyFinancials[] {
  const rows: QuarterlyFinancials[] = [];
  for (let qi = 0; qi < 8; qi++) {
    const yr = 2026 - Math.floor(qi / 4);
    const q = (4 - (qi % 4)) as 1 | 2 | 3 | 4;
    const ann = annual[Math.floor(qi / 4)] ?? annual[0]!;
    rows.push({ ...ann, fiscalYear: yr, fiscalQuarter: q, periodEnd: `${yr}-${q * 3 === 3 ? '03' : q * 3 === 6 ? '06' : q * 3 === 9 ? '09' : '12'}-31`,
      revenue: Math.round((ann.revenue ?? 0) / 4), netIncome: Math.round((ann.netIncome ?? 0) / 4),
      grossProfit: Math.round((ann.grossProfit ?? 0) / 4), ebitda: Math.round((ann.ebitda ?? 0) / 4),
      eps: Math.round(((ann.eps ?? 0) / 4) * 100) / 100, cfo: Math.round((ann.cfo ?? 0) / 4),
    });
  }
  return rows;
}

function makeEarnings(sym: string): EarningsEvent[] {
  const rows: EarningsEvent[] = [];
  const tones = ['raised', 'maintained', 'lowered', 'maintained', 'raised', 'maintained', 'raised', 'maintained'] as const;
  for (let i = 0; i < 8; i++) {
    const yr = 2026 - Math.floor(i / 4);
    const q = 4 - (i % 4);
    const epsEst = 1.80 + i * 0.05;
    const beat = i % 3 !== 2 ? 0.08 : -0.04;
    rows.push({
      fiscalPeriod: `${yr}-Q${q}`, reportDate: `${yr}-${String(q * 3).padStart(2, '0')}-15`,
      epsEstimate: Math.round(epsEst * 100) / 100, epsActual: Math.round((epsEst + beat) * 100) / 100,
      surprisePct: Math.round((beat / epsEst) * 100 * 100) / 100,
      revenueEstimate: 95_000_000_000, revenueActual: 95_000_000_000 * (1 + beat * 0.5),
      revenueSurprisePct: beat * 50, guidanceTone: tones[i] ?? 'maintained',
    });
  }
  return rows;
}

function makeOHLCV(basePrice: number, days: number): OHLCVBar[] {
  const bars: OHLCVBar[] = [];
  let price = basePrice;
  const msPerDay = 86_400_000;
  const start = Date.now() - days * msPerDay;
  for (let i = 0; i < days; i++) {
    const drift = (Math.sin(i * 0.1) * 0.005) + 0.0002;
    const vol = 0.012;
    const rng = price * vol;
    const open = price * (1 + drift * 0.3);
    const close = price * (1 + drift);
    const high = Math.max(open, close) + rng * 0.5;
    const low  = Math.min(open, close) - rng * 0.5;
    bars.push({ ts: new Date(start + i * msPerDay).toISOString(), open: Math.round(open * 100) / 100, high: Math.round(high * 100) / 100, low: Math.round(low * 100) / 100, close: Math.round(close * 100) / 100, adjustedClose: Math.round(close * 100) / 100, volume: Math.round(20_000_000 + Math.sin(i * 0.3) * 5_000_000) });
    price = close;
  }
  return bars;
}

const OHLCV_CACHE: Record<string, OHLCVBar[]> = {
  AAPL:     makeOHLCV(QUOTES['AAPL']!.price,     300),
  MSFT:     makeOHLCV(QUOTES['MSFT']!.price,     300),
  GOOGL:    makeOHLCV(QUOTES['GOOGL']!.price,    300),
  JNJ:      makeOHLCV(QUOTES['JNJ']!.price,      300),
  XOM:      makeOHLCV(QUOTES['XOM']!.price,      300),
  RELIANCE: makeOHLCV(QUOTES['RELIANCE']!.price, 300),
  TCS:      makeOHLCV(QUOTES['TCS']!.price,      300),
  INFY:     makeOHLCV(QUOTES['INFY']!.price,     300),
};

function ensureSymbol(symbol: string): void {
  if (!PROFILES[symbol]) throw new Error(`Fixture: unknown symbol "${symbol}". Supported: ${Object.keys(PROFILES).join(', ')}`);
}

// ── Adapter implementation ────────────────────────────────────────────────────

export function fixtureMarketDataAdapter(): MarketDataAdapter {
  return {
    async searchSymbols(_ctx, query): Promise<SymbolSearchResult[]> {
      const q = query.toLowerCase();
      return Object.values(PROFILES)
        .filter(p => p.symbol.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
        .map(p => ({ symbol: p.symbol, name: p.name, exchange: p.exchange, type: 'equity', currency: p.currency }));
    },

    async getProfile(_ctx, symbol): Promise<CompanyProfile> {
      ensureSymbol(symbol);
      return PROFILES[symbol]!;
    },

    async getQuote(_ctx, symbol): Promise<Quote> {
      ensureSymbol(symbol);
      return QUOTES[symbol]!;
    },

    async getOHLCV(_ctx, symbol, params: OHLCVParams): Promise<OHLCVBar[]> {
      ensureSymbol(symbol);
      const bars = OHLCV_CACHE[symbol] ?? [];
      const from = new Date(params.from).getTime();
      const to   = new Date(params.to).getTime();
      return bars.filter(b => {
        const t = new Date(b.ts).getTime();
        return t >= from && t <= to;
      });
    },

    async getFundamentals(_ctx, symbol): Promise<Fundamentals> {
      ensureSymbol(symbol);
      return FUNDAMENTALS[symbol]!;
    },

    async getAnnualFinancials(_ctx, symbol, years): Promise<AnnualFinancials[]> {
      ensureSymbol(symbol);
      return (ANNUAL_FINANCIALS[symbol] ?? []).slice(0, years);
    },

    async getQuarterlyFinancials(_ctx, symbol, quarters): Promise<QuarterlyFinancials[]> {
      ensureSymbol(symbol);
      const annual = ANNUAL_FINANCIALS[symbol] ?? [];
      return makeQuarterly(symbol, annual).slice(0, quarters);
    },

    async getEarningsHistory(_ctx, symbol, quarters): Promise<EarningsEvent[]> {
      ensureSymbol(symbol);
      return makeEarnings(symbol).slice(0, quarters);
    },

    async getAnalystConsensus(_ctx, symbol): Promise<AnalystConsensus> {
      ensureSymbol(symbol);
      const q = QUOTES[symbol]!;
      return {
        symbol, asOf: '2026-05-01',
        buyCount: 28, holdCount: 8, sellCount: 2,
        meanTargetPrice: Math.round(q.price * 1.15 * 100) / 100,
        medianTargetPrice: Math.round(q.price * 1.12 * 100) / 100,
        epsRevisions30d: { up: 6, down: 2 },
        epsRevisions90d: { up: 14, down: 5 },
        consensusEps1y: (FUNDAMENTALS[symbol]?.epsTtm ?? 5) * 1.12,
        consensusEps2y: (FUNDAMENTALS[symbol]?.epsTtm ?? 5) * 1.26,
        consensusRevenue1y: (ANNUAL_FINANCIALS[symbol]?.[0]?.revenue ?? 100e9) * 1.10,
        longTermGrowthEstimate: 0.12,
      };
    },

    async getDividends(_ctx, symbol, years): Promise<DividendEvent[]> {
      ensureSymbol(symbol);
      const p = PROFILES[symbol]!;
      const q = QUOTES[symbol]!;
      const divYield = FUNDAMENTALS[symbol]?.dividendYield ?? 0;
      if (divYield === 0) return [];
      const annualDiv = q.price * divYield;
      const rows: DividendEvent[] = [];
      for (let i = 0; i < years * 4; i++) {
        const d = new Date(`2026-05-01`);
        d.setMonth(d.getMonth() - i * 3);
        rows.push({ exDate: d.toISOString().slice(0, 10), payDate: null, amount: Math.round(annualDiv / 4 * 100) / 100, currency: p.currency });
      }
      return rows;
    },

    async getSplits(_ctx, symbol): Promise<SplitEvent[]> {
      ensureSymbol(symbol);
      if (symbol === 'AAPL') return [{ exDate: '2020-08-31', numerator: 4, denominator: 1 }];
      if (symbol === 'GOOGL') return [{ exDate: '2022-07-15', numerator: 20, denominator: 1 }];
      return [];
    },

    async getSECFilings(_ctx, symbol, formTypes): Promise<SECFilingRef[]> {
      ensureSymbol(symbol);
      const types = formTypes ?? ['10-K', '10-Q', '8-K'];
      return types.slice(0, 3).map((ft, i) => ({
        formType: ft, filedDate: `2026-0${i + 2}-15`, periodOfReport: `2026-0${i + 1}-31`,
        accessionNumber: `0001234567${i + 1}-26-00000${i + 1}`,
        url: `https://www.sec.gov/Archives/edgar/data/320193/000132450726000001/${ft.toLowerCase()}.htm`,
      }));
    },

    async getInsiderTransactions(_ctx, symbol, days): Promise<InsiderTransaction[]> {
      ensureSymbol(symbol);
      const q = QUOTES[symbol]!;
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      return [
        { symbol, insiderName: 'Jane Executive', insiderTitle: 'CEO', transactionDate: '2026-04-15', transactionCode: 'P' as const, shares: 5000, pricePerShare: q.price * 0.97, valueUsd: 5000 * q.price * 0.97, sharesOwnedAfter: 120_000 },
        { symbol, insiderName: 'John Director', insiderTitle: 'Director', transactionDate: '2026-03-20', transactionCode: 'P' as const, shares: 2000, pricePerShare: q.price * 0.94, valueUsd: 2000 * q.price * 0.94, sharesOwnedAfter: 45_000 },
        { symbol, insiderName: 'Alice CFO', insiderTitle: 'CFO', transactionDate: '2026-02-10', transactionCode: 'S' as const, shares: 8000, pricePerShare: q.price * 1.02, valueUsd: 8000 * q.price * 1.02, sharesOwnedAfter: 95_000 },
      ].filter(t => t.transactionDate >= cutoff);
    },

    async getInstitutionalHoldings(_ctx, symbol): Promise<InstitutionalHolding[]> {
      ensureSymbol(symbol);
      return [
        { symbol, filer: 'Vanguard Group', filerType: 'mutual_fund', asOf: '2026-03-31', shares: 500_000_000, marketValue: 500_000_000 * (QUOTES[symbol]?.price ?? 100), shareChangeQoq: 5_000_000, shareChangePctQoq: 0.01 },
        { symbol, filer: 'BlackRock Inc',  filerType: 'mutual_fund', asOf: '2026-03-31', shares: 420_000_000, marketValue: 420_000_000 * (QUOTES[symbol]?.price ?? 100), shareChangeQoq: -8_000_000, shareChangePctQoq: -0.019 },
        { symbol, filer: 'Bridgewater',    filerType: 'hedge_fund',   asOf: '2026-03-31', shares: 12_000_000,  marketValue: 12_000_000  * (QUOTES[symbol]?.price ?? 100), shareChangeQoq: 3_000_000,  shareChangePctQoq: 0.033 },
      ];
    },

    async getShortInterest(_ctx, symbol): Promise<ShortInterest> {
      ensureSymbol(symbol);
      return { symbol, asOf: '2026-05-15', shortShares: 80_000_000, shortPctFloat: 0.018, daysToCover: 1.4, costToBorrow: 0.45 };
    },

    async getOptionsSummary(_ctx, symbol): Promise<OptionsSummary | null> {
      ensureSymbol(symbol);
      return { symbol, asOf: '2026-05-29', putCallRatioOI: 0.72, putCallRatioVolume: 0.68, impliedVolatility30d: 0.24, ivRank: 42, skew25Delta: -0.08, totalOpenInterest: 4_200_000 };
    },

    async getMacroSnapshot(_ctx, region): Promise<MacroSnapshot> {
      const snapshots: Record<MacroSnapshot['region'], MacroSnapshot> = {
        US:     { asOf: '2026-05-01', region: 'US',     policyRate: 4.25, cpiYoy: 0.031, gdpGrowthYoy: 0.022, unemploymentRate: 0.042, yieldCurve10y2y: 0.15,  vix: 18.5 },
        IN:     { asOf: '2026-05-01', region: 'IN',     policyRate: 6.25, cpiYoy: 0.048, gdpGrowthYoy: 0.068, unemploymentRate: 0.082, yieldCurve10y2y: 0.35,  vix: null },
        EU:     { asOf: '2026-05-01', region: 'EU',     policyRate: 3.50, cpiYoy: 0.022, gdpGrowthYoy: 0.012, unemploymentRate: 0.062, yieldCurve10y2y: 0.05,  vix: null },
        UK:     { asOf: '2026-05-01', region: 'UK',     policyRate: 4.75, cpiYoy: 0.028, gdpGrowthYoy: 0.011, unemploymentRate: 0.044, yieldCurve10y2y: 0.08,  vix: null },
        GLOBAL: { asOf: '2026-05-01', region: 'GLOBAL', policyRate: null, cpiYoy: 0.035, gdpGrowthYoy: 0.031, unemploymentRate: null,  yieldCurve10y2y: null,  vix: 18.5 },
      };
      return snapshots[region];
    },

    async getFxRate(_ctx, from, to): Promise<FxRate> {
      const rates: Record<string, number> = { 'USD/INR': 83.5, 'INR/USD': 1/83.5, 'USD/EUR': 0.92, 'EUR/USD': 1.087, 'USD/GBP': 0.79, 'GBP/USD': 1.266 };
      const key = `${from}/${to}`;
      const rate = rates[key] ?? (from === to ? 1.0 : null);
      if (rate === null) throw new Error(`Fixture: FX pair ${key} not in fixture data`);
      return { from, to, rate, asOf: '2026-05-29T00:00:00Z' };
    },
  };
}
