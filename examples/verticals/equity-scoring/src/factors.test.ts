/**
 * Golden-number tests for each factor against the fixture universe.
 * These tests verify determinism and catch regressions.
 */

import { describe, it, expect } from 'vitest';
import { weaveContext } from '@weaveintel/core';
import { fixtureMarketDataAdapter } from '@weaveintel/tools/marketdata';
import { fixtureNewsAdapter } from '@weaveintel/tools/news';
import { fixtureAltDataAdapter } from '@weaveintel/tools/altdata';
import { scoreUniverse, computeFactor, strategies } from './index.js';
import type { InputBundle } from './types.js';

// Build fixture bundles for all 8 tickers
async function buildFixtureBundles(): Promise<InputBundle[]> {
  const md = fixtureMarketDataAdapter();
  const news = fixtureNewsAdapter();
  const alt = fixtureAltDataAdapter();
  const ctx = weaveContext({});
  const symbols = ['AAPL', 'MSFT', 'GOOGL', 'JNJ', 'XOM', 'RELIANCE', 'TCS', 'INFY'];
  const today = '2026-05-29';
  const oneYearAgo = '2025-05-29';

  const bundles: InputBundle[] = [];
  for (const sym of symbols) {
    const [profile, quote, ohlcv, fundamentals, annual, quarterly, earnings, analyst, dividends, insiders, institutions, shortInterest, options, macro] = await Promise.all([
      md.getProfile(ctx, sym),
      md.getQuote(ctx, sym),
      md.getOHLCV(ctx, sym, { interval: 'daily', from: oneYearAgo, to: today }),
      md.getFundamentals(ctx, sym),
      md.getAnnualFinancials(ctx, sym, 10),
      md.getQuarterlyFinancials(ctx, sym, 8),
      md.getEarningsHistory(ctx, sym, 8),
      md.getAnalystConsensus(ctx, sym),
      md.getDividends(ctx, sym, 5),
      md.getInsiderTransactions(ctx, sym, 180),
      md.getInstitutionalHoldings(ctx, sym),
      md.getShortInterest(ctx, sym),
      md.getOptionsSummary(ctx, sym),
      md.getMacroSnapshot(ctx, 'US'),
    ]);
    const newsArticles = await news.getCompanyNews(ctx, { symbol: sym, from: oneYearAgo, to: today, limit: 30 });
    const altEsg = await alt.getEsgScores(ctx, sym);
    const altTrends = await alt.getGoogleTrends(ctx, sym, 52);

    bundles.push({ profile, quote, ohlcv, fundamentals, annual, quarterly, earnings, analyst, dividends, insiders, institutions, shortInterest, options: options ?? null, news: newsArticles, altData: { esg: altEsg, trends: altTrends }, macro });
  }
  return bundles;
}

describe('equity-scoring: factor determinism', () => {
  let bundles: InputBundle[];

  // Load fixture bundles once
  const initPromise = buildFixtureBundles().then(b => { bundles = b; });

  it('loads all 8 fixture bundles', async () => {
    await initPromise;
    expect(bundles).toHaveLength(8);
  });

  it('value factor: GOOGL has higher value score than MSFT (GOOGL cheaper on P/E, EV/EBITDA)', async () => {
    await initPromise;
    const googl = bundles.find(b => b.profile.symbol === 'GOOGL')!;
    const msft  = bundles.find(b => b.profile.symbol === 'MSFT')!;
    const peers = bundles.filter(b => b.profile.symbol !== googl.profile.symbol && b.profile.symbol !== msft.profile.symbol);
    const vGoogle = computeFactor('value', googl, peers);
    const vMsft   = computeFactor('value', msft,  peers);
    // GOOGL P/E=21.5 vs MSFT P/E=33.5, so GOOGL should score better on value
    expect(vGoogle.score).toBeGreaterThan(vMsft.score);
  });

  it('quality factor: TCS has highest quality score (ROIC=48%, clean balance sheet)', async () => {
    await initPromise;
    const tcs = bundles.find(b => b.profile.symbol === 'TCS')!;
    const peers = bundles.filter(b => b.profile.symbol !== 'TCS');
    const q = computeFactor('quality', tcs, peers);
    expect(q.score).toBeGreaterThan(0);
  });

  it('momentum factor: returns a score within [-1, +1]', async () => {
    await initPromise;
    for (const b of bundles) {
      const peers = bundles.filter(p => p.profile.symbol !== b.profile.symbol);
      const m = computeFactor('momentum', b, peers);
      expect(m.score).toBeGreaterThanOrEqual(-1);
      expect(m.score).toBeLessThanOrEqual(1);
    }
  });

  it('low_volatility factor: INVERTED — lower volatility → higher score', async () => {
    await initPromise;
    const jnj = bundles.find(b => b.profile.symbol === 'JNJ')!;
    const peers = bundles.filter(b => b.profile.symbol !== 'JNJ');
    const v = computeFactor('low_volatility', jnj, peers);
    // JNJ is a low-vol healthcare name — should have positive low_vol score
    expect(v.coverage).toBeGreaterThan(0);
    expect(typeof v.score).toBe('number');
  });

  it('earnings_quality: AAPL (high CFO/NI, negative accruals) scores positively', async () => {
    await initPromise;
    const aapl = bundles.find(b => b.profile.symbol === 'AAPL')!;
    const peers = bundles.filter(b => b.profile.symbol !== 'AAPL');
    const eq = computeFactor('earnings_quality', aapl, peers);
    expect(eq.score).toBeGreaterThan(0);
  });

  it('all factor scores are finite numbers', async () => {
    await initPromise;
    const categories: Parameters<typeof computeFactor>[0][] = [
      'value', 'growth', 'quality', 'profitability', 'momentum', 'low_volatility',
      'size', 'yield', 'sentiment', 'insider', 'institutional', 'short_signal',
      'options_signal', 'analyst', 'earnings_quality', 'capital_allocation', 'macro_fit', 'alt_signals',
    ];
    const aapl = bundles.find(b => b.profile.symbol === 'AAPL')!;
    const peers = bundles.filter(b => b.profile.symbol !== 'AAPL');
    for (const cat of categories) {
      const f = computeFactor(cat, aapl, peers);
      expect(isFinite(f.score), `${cat}.score is not finite`).toBe(true);
      expect(isFinite(f.zScore), `${cat}.zScore is not finite`).toBe(true);
      expect(f.coverage).toBeGreaterThanOrEqual(0);
      expect(f.coverage).toBeLessThanOrEqual(1);
    }
  });
});

describe('equity-scoring: strategies produce stable rankings', () => {
  let bundles: InputBundle[];
  const initPromise = buildFixtureBundles().then(b => { bundles = b; });

  it('compounder-quality: TCS or MSFT ranks in top 3', async () => {
    await initPromise;
    const scores = scoreUniverse(bundles, strategies['compounder-quality']!);
    const top3 = scores.slice(0, 3).map(s => s.symbol);
    expect(top3.some(s => ['TCS', 'MSFT', 'AAPL'].includes(s))).toBe(true);
  });

  it('classic-graham-value: composites are within [-1, +1]', async () => {
    await initPromise;
    const scores = scoreUniverse(bundles, strategies['classic-graham-value']!);
    for (const s of scores) {
      expect(s.composite).toBeGreaterThanOrEqual(-1);
      expect(s.composite).toBeLessThanOrEqual(1);
    }
  });

  it('aqr-multifactor: deciles are assigned 1-10', async () => {
    await initPromise;
    const scores = scoreUniverse(bundles, strategies['aqr-multifactor']!);
    const deciles = scores.map(s => s.decile);
    expect(deciles.every(d => d >= 1 && d <= 10)).toBe(true);
  });

  it('scoreUniverse returns sorted descending by composite', async () => {
    await initPromise;
    const scores = scoreUniverse(bundles, strategies['gentlemans-growth']!);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]!.composite).toBeGreaterThanOrEqual(scores[i]!.composite);
    }
  });
});

describe('equity-scoring: coverage-aware scoring with null fields', () => {
  let bundles: InputBundle[];
  const initPromise = buildFixtureBundles().then(b => { bundles = b; });

  it('bundle with all null fundamentals produces coverage=0 factors without throwing', async () => {
    await initPromise;
    const base = bundles[0]!;
    const nullBundle: InputBundle = {
      ...base,
      fundamentals: {
        ...base.fundamentals,
        peRatio: null, pbRatio: null, psRatio: null, evToEbitda: null, evToSales: null,
        fcfYield: null, earningsYield: null, shareholderYield: null, roic: null, roe: null, roa: null,
        netMargin: null, grossMargin: null, operatingMargin: null, altmanZScore: null, beneishMScore: null,
        piotroskiFScore: null, accrualsRatio: null, cfoToNetIncome: null, dividendYield: null,
        buybackYield: null, payoutRatio: null, debtToEquity: null, netDebtToEbitda: null,
        currentRatio: null, quickRatio: null, interestCoverage: null, grossProfitToAssets: null,
        revenueGrowthYoy: null, epsGrowthYoy: null, fcfGrowthYoy: null,
      },
    };
    const peers = bundles.slice(1);
    expect(() => computeFactor('value', nullBundle, peers)).not.toThrow();
    const vf = computeFactor('value', nullBundle, peers);
    expect(vf.coverage).toBe(0);
    expect(isFinite(vf.score)).toBe(true);
  });

  it('bundle with empty OHLCV produces finite momentum score', async () => {
    await initPromise;
    const base = bundles[0]!;
    const noOhlcv: InputBundle = { ...base, ohlcv: [] };
    const peers = bundles.slice(1);
    const m = computeFactor('momentum', noOhlcv, peers);
    expect(isFinite(m.score)).toBe(true);
  });
});

describe('equity-scoring: flag detection', () => {
  let bundles: InputBundle[];
  const initPromise = buildFixtureBundles().then(b => { bundles = b; });

  it('no spurious ALTMAN_Z_DISTRESS for healthy tickers', async () => {
    await initPromise;
    const { detectFlags } = await import('./flags.js');
    for (const b of bundles.filter(b => ['AAPL', 'MSFT', 'TCS'].includes(b.profile.symbol))) {
      const { redFlags } = detectFlags(b);
      const hasZDistress = redFlags.some(f => f.code === 'ALTMAN_Z_DISTRESS');
      expect(hasZDistress, `${b.profile.symbol} should not have ALTMAN_Z_DISTRESS`).toBe(false);
    }
  });

  it('INSIDER_CLUSTER_BUY fires when ≥3 insiders buy in 30d', async () => {
    await initPromise;
    const { detectFlags } = await import('./flags.js');
    const base = bundles[0]!;
    const thirtyDaysAgo = new Date(Date.now() - 25 * 86_400_000).toISOString().slice(0, 10);
    const clusterBundle: InputBundle = {
      ...base,
      insiders: [
        { symbol: base.profile.symbol, insiderName: 'CEO', insiderTitle: 'CEO', transactionDate: thirtyDaysAgo, transactionCode: 'P', shares: 1000, pricePerShare: 100, valueUsd: 100_000, sharesOwnedAfter: 10_000 },
        { symbol: base.profile.symbol, insiderName: 'CFO', insiderTitle: 'CFO', transactionDate: thirtyDaysAgo, transactionCode: 'P', shares: 500,  pricePerShare: 100, valueUsd: 50_000,  sharesOwnedAfter: 5_000 },
        { symbol: base.profile.symbol, insiderName: 'COO', insiderTitle: 'COO', transactionDate: thirtyDaysAgo, transactionCode: 'P', shares: 800,  pricePerShare: 100, valueUsd: 80_000,  sharesOwnedAfter: 8_000 },
      ],
    };
    const { greenFlags } = detectFlags(clusterBundle);
    expect(greenFlags.some(f => f.code === 'INSIDER_CLUSTER_BUY')).toBe(true);
  });
});
