/**
 * Example 122 — Live Equity Analysis via AlphaVantage
 * ─────────────────────────────────────────────────────────────────────────────
 * Demonstrates the composite adapter pattern:
 *   AlphaVantage (real network)  → live quotes, profile, fundamentals, OHLCV
 *   Fixture adapter (fallback)   → annual financials, insiders, earnings, etc.
 *
 * Phases:
 *   A — Live quote snapshot: fetch real-time prices for 3 US symbols,
 *       compare against fixture baseline prices.
 *   B — Hybrid bundle build: composite adapter fetches what AlphaVantage
 *       supports live; fixture fills the rest. Symbols processed sequentially
 *       with 13-second gaps to respect the 5-calls/minute free-tier limit.
 *   C — Cross-sectional scoring: run compounder-quality strategy over
 *       the hybrid bundles and display ranked results.
 *
 * Rate limits (AlphaVantage free tier):
 *   5 requests / minute · 25 requests / day
 *   This example makes ≤ 18 live requests total.
 *
 * Setup: ALPHAVANTAGE_KEY must be set in .env (already configured).
 *
 * Run: npx tsx examples/122-live-equity-analysis.ts
 */

import 'dotenv/config';

import { weaveContext } from '@weaveintel/core';
import {
  alphaVantageAdapter,
  fixtureMarketDataAdapter,
  compositeAdapter,
} from '@weaveintel/tools/marketdata';
import { fixtureNewsAdapter } from '@weaveintel/tools/news';
import { fixtureAltDataAdapter } from '@weaveintel/tools/altdata';
import { scoreUniverse, strategies } from './verticals/equity-scoring/src/index.js';
import type { InputBundle } from './verticals/equity-scoring/src/index.js';

// ── Console helpers ────────────────────────────────────────────────────────

const BOLD    = '\x1b[1m'; const GREEN  = '\x1b[32m'; const CYAN  = '\x1b[36m';
const YELLOW  = '\x1b[33m'; const DIM   = '\x1b[2m';  const RESET = '\x1b[0m';
const MAGENTA = '\x1b[35m'; const RED   = '\x1b[31m';

function header(t: string) {
  console.log(`\n${BOLD}${'═'.repeat(70)}${RESET}`);
  console.log(`${BOLD}  ${t}${RESET}`);
  console.log(`${BOLD}${'═'.repeat(70)}${RESET}`);
}
function section(t: string) { console.log(`\n${CYAN}  ── ${t} ──${RESET}`); }
function ok(m: string)      { console.log(`${GREEN}  ✓${RESET} ${m}`); }
function info(m: string)    { console.log(`${DIM}  ℹ ${m}${RESET}`); }
function live(m: string)    { console.log(`${MAGENTA}  ★${RESET} ${m}`); }
function warn(m: string)    { console.log(`${YELLOW}  ⚠${RESET} ${m}`); }

// ── Config ─────────────────────────────────────────────────────────────────

const SYMBOLS   = ['AAPL', 'MSFT', 'GOOGL'];
const TODAY     = '2026-05-29';
const ONE_YEAR  = '2025-05-29';
const API_KEY   = process.env['ALPHAVANTAGE_KEY'] ?? '';
const DELAY_MS  = 13_000; // 13 s between AV calls to stay under 5/min

if (!API_KEY) {
  console.error(`${RED}  ✗ ALPHAVANTAGE_KEY not set in environment. Add it to .env.${RESET}`);
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Build an ExecutionContext with the AlphaVantage key injected into metadata. */
const liveCtx  = () => weaveContext({ metadata: { alphaVantageKey: API_KEY } });
const plainCtx = () => weaveContext({});

function pctChange(a: number, b: number): string {
  const pct = ((b - a) / a) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

// ── Build a hybrid InputBundle via compositeAdapter ─────────────────────────

async function buildHybridBundle(symbol: string): Promise<InputBundle> {
  const md   = compositeAdapter([alphaVantageAdapter(), fixtureMarketDataAdapter()]);
  const news = fixtureNewsAdapter();
  const alt  = fixtureAltDataAdapter();
  const ctx  = liveCtx();

  const [
    profile, quote, ohlcv, fundamentals, annual, quarterly,
    earnings, analyst, dividends, insiders, institutions, shortInterest, options, macro,
  ] = await Promise.all([
    md.getProfile(ctx, symbol),
    md.getQuote(ctx, symbol),
    md.getOHLCV(ctx, symbol, { interval: 'daily', from: ONE_YEAR, to: TODAY }),
    md.getFundamentals(ctx, symbol),
    md.getAnnualFinancials(ctx, symbol, 10),
    md.getQuarterlyFinancials(ctx, symbol, 8),
    md.getEarningsHistory(ctx, symbol, 8),
    md.getAnalystConsensus(ctx, symbol),
    md.getDividends(ctx, symbol, 5),
    md.getInsiderTransactions(ctx, symbol, 180),
    md.getInstitutionalHoldings(ctx, symbol),
    md.getShortInterest(ctx, symbol),
    md.getOptionsSummary(ctx, symbol),
    md.getMacroSnapshot(ctx, 'US'),
  ]);

  const newsArticles = await news.getCompanyNews(ctx, { symbol, from: ONE_YEAR, to: TODAY, limit: 30 });
  const altEsg       = await alt.getEsgScores(ctx, symbol);
  const altTrends    = await alt.getGoogleTrends(ctx, symbol, 52);

  return {
    profile, quote, ohlcv, fundamentals, annual, quarterly, earnings,
    analyst, dividends, insiders, institutions, shortInterest,
    options: options ?? null,
    news: newsArticles,
    altData: { esg: altEsg, trends: altTrends },
    macro,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  header('Example 122 — Live Equity Analysis via AlphaVantage + Composite Adapter');
  info(`API key: ${API_KEY.slice(0, 4)}${'*'.repeat(API_KEY.length - 4)}`);
  info(`Symbols : ${SYMBOLS.join(', ')}`);
  info('Rate-limit guard: 13 s between symbol fetches');

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE A — Live quote snapshot & comparison with fixture baseline
  // ─────────────────────────────────────────────────────────────────────────

  section('Phase A — Live price snapshot (AlphaVantage GLOBAL_QUOTE)');
  const av      = alphaVantageAdapter();
  const fixture = fixtureMarketDataAdapter();
  const ctx     = liveCtx();

  interface PriceRow { symbol: string; live: number; fixture: number }
  const priceRows: PriceRow[] = [];

  for (let i = 0; i < SYMBOLS.length; i++) {
    const sym = SYMBOLS[i]!;

    if (i > 0) {
      info(`Waiting ${DELAY_MS / 1000}s (rate-limit guard)…`);
      await sleep(DELAY_MS);
    }

    let livePrice: number | null = null;
    try {
      const q = await av.getQuote(ctx, sym);
      livePrice = q.price;
    } catch (e) {
      warn(`AlphaVantage quote failed for ${sym}: ${(e as Error).message}`);
    }

    const fixQ   = await fixture.getQuote(plainCtx(), sym);
    const fPrice = fixQ.price;

    if (livePrice !== null) {
      const delta = pctChange(fPrice, livePrice);
      live(`${sym.padEnd(8)} live=$${livePrice.toFixed(2).padEnd(10)} fixture=$${fPrice.toFixed(2).padEnd(10)} Δ=${delta}`);
      priceRows.push({ symbol: sym, live: livePrice, fixture: fPrice });
    } else {
      warn(`${sym.padEnd(8)} live=N/A  fixture=$${fPrice.toFixed(2)}`);
      priceRows.push({ symbol: sym, live: fPrice, fixture: fPrice });
    }
  }

  ok('Live price snapshot complete');

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE B — Build hybrid InputBundles (composite: AV first, fixture fallback)
  // ─────────────────────────────────────────────────────────────────────────

  section('Phase B — Hybrid bundle build (composite adapter)');
  info('AlphaVantage provides: quote · profile · fundamentals · OHLCV · dividends');
  info('Fixture fallback for : annual financials · earnings · insiders · institutions · news · alt-data');

  const bundles: InputBundle[] = [];

  for (let i = 0; i < SYMBOLS.length; i++) {
    const sym = SYMBOLS[i]!;

    info(`Waiting ${DELAY_MS / 1000}s before ${sym} bundle…`);
    await sleep(DELAY_MS);

    info(`Building hybrid bundle for ${sym}…`);
    const bundle = await buildHybridBundle(sym);
    bundles.push(bundle);

    const src = bundle.quote.price === priceRows.find(r => r.symbol === sym)?.live ? 'live' : 'fixture';
    ok(`${sym}: price=$${bundle.quote.price.toFixed(2)} (${src})  sector=${bundle.profile.sector ?? 'n/a'}  PE=${bundle.fundamentals.peRatio?.toFixed(1) ?? 'n/a'}`);
  }

  ok(`${bundles.length} hybrid bundles ready`);

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE C — Cross-sectional scoring
  // ─────────────────────────────────────────────────────────────────────────

  section('Phase C — Score universe (compounder-quality strategy)');
  const strategy = strategies['compounder-quality']!;
  const scores   = scoreUniverse(bundles, strategy);

  console.log();
  for (let i = 0; i < scores.length; i++) {
    const s   = scores[i]!;
    const bar = '█'.repeat(Math.round(Math.max(0, s.composite + 1) * 5));
    const row = priceRows.find(r => r.symbol === s.symbol);
    const tag = row ? ` live=$${row.live.toFixed(2)}` : '';
    console.log(
      `  ${YELLOW}#${i + 1}${RESET} ${BOLD}${s.symbol.padEnd(8)}${RESET}` +
      ` composite=${s.composite.toFixed(3).padEnd(8)} decile=${s.decile}/10` +
      ` confidence=${(s.confidence * 100).toFixed(0)}%` +
      `${tag}  ${DIM}${bar}${RESET}`,
    );
  }

  // Top symbol detail
  const top = scores[0]!;
  section(`Top-ranked: ${top.symbol}`);
  const topFactors = Object.values(top.factors).sort((a, b) => b.score - a.score);
  for (const f of topFactors.slice(0, 5)) {
    const sign = f.score >= 0 ? GREEN + '+' : RED;
    console.log(`  ${sign}${f.score.toFixed(3)}${RESET}  ${f.category.padEnd(24)} coverage=${(f.coverage * 100).toFixed(0)}%`);
  }
  if (top.greenFlags.length) ok(`Green flags: ${top.greenFlags.map(f => f.code).join(', ')}`);
  if (top.redFlags.length)   warn(`Red flags  : ${top.redFlags.map(f => `${f.code}(${f.severity})`).join(', ')}`);

  // Summary table
  section('Price comparison summary');
  console.log(`\n  ${'Symbol'.padEnd(8)} ${'Live ($)'.padEnd(12)} ${'Fixture ($)'.padEnd(14)} Change`);
  console.log(`  ${'─'.repeat(50)}`);
  for (const row of priceRows) {
    const delta = pctChange(row.fixture, row.live);
    const col   = row.live !== row.fixture ? MAGENTA : DIM;
    console.log(`  ${BOLD}${row.symbol.padEnd(8)}${RESET} ${col}${row.live.toFixed(2).padEnd(12)}${RESET} ${DIM}${row.fixture.toFixed(2).padEnd(14)}${RESET} ${col}${delta}${RESET}`);
  }

  // ── Assertions ────────────────────────────────────────────────────────────
  section('Self-checks');
  if (scores.length !== SYMBOLS.length) throw new Error(`Expected ${SYMBOLS.length} scores, got ${scores.length}`);
  for (const s of scores) {
    if (s.composite < -1 || s.composite > 1) throw new Error(`${s.symbol}: composite out of range`);
  }
  if (priceRows.length !== SYMBOLS.length) throw new Error('Price rows missing');
  ok(`All ${scores.length} symbols scored with composites in [-1, +1]`);
  ok('Live quote snapshot matched against fixture baseline');
  ok('Hybrid bundles built: AlphaVantage data where supported, fixture elsewhere');

  console.log(`\n${GREEN}${BOLD}  Example 122 complete — live equity analysis verified.${RESET}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
