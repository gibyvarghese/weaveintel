/**
 * Example 120 — Equity Analyst Mesh (offline, fixture data)
 * ─────────────────────────────────────────────────────────────────────────────
 * Demonstrates a 5-agent analysis mesh using the equity intelligence packages:
 *
 *   1. Universe Builder     — selects the 8 fixture tickers and fetches all
 *                             market data, news, and alt-data bundles
 *   2. Data Collector ×3   — fan-out workers, each handling a slice of symbols
 *                             (simulated parallel; each builds an InputBundle)
 *   3. Scorer              — runs scoreUniverse() over all bundles
 *   4. Thesis Writer       — calls buildEquityThesis() for the top-3 symbols
 *   5. Supervisor          — prints a ranked report with thesis excerpts
 *
 * ─── Packages used ──────────────────────────────────────────────────────────
 *   @weaveintel/core
 *     • weaveContext         — execution context carrier
 *   @weaveintel/tools/marketdata
 *     • fixtureMarketDataAdapter — deterministic market data, no network
 *   @weaveintel/tools/news
 *     • fixtureNewsAdapter       — deterministic news articles, no network
 *   @weaveintel/tools/altdata
 *     • fixtureAltDataAdapter    — deterministic ESG / trends data, no network
 *   ./verticals/equity-scoring/src/index.js
 *     • scoreUniverse            — cross-sectional z-score ranking
 *     • computeFactor            — individual factor computation
 *     • strategies               — pre-built ScoringStrategy registry
 *     • explainScore             — markdown factor breakdown
 *
 * ─── Local helpers (NOT from any package) ───────────────────────────────────
 *   buildBundle()       — assembles an InputBundle from the three fixture adapters
 *   buildEquityThesis() — prose summary of a SymbolScore (simulates the LLM skill)
 *
 * Run: npx tsx examples/120-equity-analyst-mesh.ts
 */

import { weaveContext } from '@weaveintel/core';
import { fixtureMarketDataAdapter } from '@weaveintel/tools/marketdata';
import { fixtureNewsAdapter } from '@weaveintel/tools/news';
import { fixtureAltDataAdapter } from '@weaveintel/tools/altdata';
import {
  scoreUniverse,
  explainScore,
  strategies,
} from './verticals/equity-scoring/src/index.js';
import type { InputBundle, SymbolScore } from './verticals/equity-scoring/src/index.js';

// ── Console helpers ────────────────────────────────────────────────────────

const BOLD = '\x1b[1m'; const GREEN = '\x1b[32m'; const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m'; const DIM = '\x1b[2m'; const RESET = '\x1b[0m';
const MAGENTA = '\x1b[35m';

function header(t: string) {
  console.log(`\n${BOLD}${'═'.repeat(70)}${RESET}`);
  console.log(`${BOLD}  ${t}${RESET}`);
  console.log(`${BOLD}${'═'.repeat(70)}${RESET}`);
}
function section(t: string) { console.log(`\n${CYAN}  ── ${t} ──${RESET}`); }
function ok(m: string)      { console.log(`${GREEN}  ✓${RESET} ${m}`); }
function info(m: string)    { console.log(`${DIM}  ℹ ${m}${RESET}`); }
function agent(name: string, m: string) { console.log(`${MAGENTA}  [${name}]${RESET} ${m}`); }
function rank(n: number, s: SymbolScore) {
  const bar = '█'.repeat(Math.round(Math.max(0, s.composite + 1) * 5));
  console.log(`${YELLOW}  #${n.toString().padEnd(2)}${RESET} ${BOLD}${s.symbol.padEnd(10)}${RESET} composite=${s.composite.toFixed(3).padEnd(8)} decile=${s.decile}/10  confidence=${(s.confidence * 100).toFixed(0)}%  ${DIM}${bar}${RESET}`);
}

// ── Local: InputBundle assembler ───────────────────────────────────────────

async function buildBundle(symbol: string): Promise<InputBundle> {
  const md   = fixtureMarketDataAdapter();
  const news = fixtureNewsAdapter();
  const alt  = fixtureAltDataAdapter();
  const ctx  = weaveContext({});

  const today      = '2026-05-29';
  const oneYearAgo = '2025-05-29';

  const [
    profile, quote, ohlcv, fundamentals, annual, quarterly,
    earnings, analyst, dividends, insiders, institutions, shortInterest, options, macro,
  ] = await Promise.all([
    md.getProfile(ctx, symbol),
    md.getQuote(ctx, symbol),
    md.getOHLCV(ctx, symbol, { interval: 'daily', from: oneYearAgo, to: today }),
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

  const newsArticles = await news.getCompanyNews(ctx, { symbol, from: oneYearAgo, to: today, limit: 30 });
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

// ── Local: equity thesis prose (simulates skill-equity-thesis LLM call) ────

function buildEquityThesis(score: SymbolScore): string {
  const factorList = Object.values(score.factors);
  const top3 = factorList.slice().sort((a, b) => b.score - a.score).slice(0, 3);
  const bot2 = factorList.slice().sort((a, b) => a.score - b.score).slice(0, 2);

  const redFlagSummary   = score.redFlags.length   ? score.redFlags.map(f => `${f.code} (${f.severity})`).join(', ')   : 'None';
  const greenFlagSummary = score.greenFlags.length ? score.greenFlags.map(f => f.code).join(', ') : 'None';

  return [
    `${score.symbol} scores ${score.composite.toFixed(3)} composite (decile ${score.decile}/10, confidence ${(score.confidence * 100).toFixed(0)}%).`,
    `Top positive factors: ${top3.map(f => `${f.category} (${f.score > 0 ? '+' : ''}${f.score.toFixed(2)}, coverage ${(f.coverage * 100).toFixed(0)}%)`).join('; ')}.`,
    `Weakest factors: ${bot2.map(f => `${f.category} (${f.score.toFixed(2)})`).join('; ')}.`,
    `Green flags: ${greenFlagSummary}. Red flags: ${redFlagSummary}.`,
    `Peer count: ${score.peerSet.size}.`,
  ].join(' ');
}

// ── Agent: Universe Builder ────────────────────────────────────────────────

async function agentUniverseBuilder(): Promise<string[]> {
  agent('UniverseBuilder', 'Selecting fixture universe: 8 tickers (5 US, 3 NSE)');
  const symbols = ['AAPL', 'MSFT', 'GOOGL', 'JNJ', 'XOM', 'RELIANCE', 'TCS', 'INFY'];
  ok(`Universe locked: ${symbols.join(', ')}`);
  return symbols;
}

// ── Agent: Data Collector (simulated fan-out) ──────────────────────────────

async function agentDataCollector(symbols: string[], sliceLabel: string): Promise<InputBundle[]> {
  agent('DataCollector', `[${sliceLabel}] Fetching bundles for: ${symbols.join(', ')}`);
  const bundles = await Promise.all(symbols.map(sym => buildBundle(sym)));
  ok(`[${sliceLabel}] ${bundles.length} bundles assembled`);
  return bundles;
}

// ── Agent: Scorer ──────────────────────────────────────────────────────────

async function agentScorer(bundles: InputBundle[], strategyKey: string): Promise<SymbolScore[]> {
  agent('Scorer', `Running scoreUniverse() with strategy '${strategyKey}'`);
  const strategy = strategies[strategyKey];
  if (!strategy) throw new Error(`Unknown strategy: ${strategyKey}`);
  const scores = scoreUniverse(bundles, strategy);
  ok(`Scored ${scores.length} symbols`);
  return scores;
}

// ── Agent: Thesis Writer ───────────────────────────────────────────────────

async function agentThesisWriter(scores: SymbolScore[]): Promise<Map<string, string>> {
  const top3 = scores.slice(0, 3);
  agent('ThesisWriter', `Writing equity thesis for top-3 symbols: ${top3.map(s => s.symbol).join(', ')}`);
  const theses = new Map<string, string>();
  for (const score of top3) {
    theses.set(score.symbol, buildEquityThesis(score));
    ok(`Thesis written for ${score.symbol}`);
  }
  return theses;
}

// ── Main: Supervisor ───────────────────────────────────────────────────────

async function main() {
  header('Example 120 — Equity Analyst Mesh (offline, fixture data)');

  // ── Step 1: Universe Builder ───────────────────────────────────────────
  section('Agent 1 — Universe Builder');
  const symbols = await agentUniverseBuilder();

  // ── Step 2: Data Collector fan-out (3 simulated workers) ──────────────
  section('Agent 2/3/4 — Data Collector (fan-out ×3)');
  const slice1 = symbols.slice(0, 3);
  const slice2 = symbols.slice(3, 6);
  const slice3 = symbols.slice(6);

  const [bundles1, bundles2, bundles3] = await Promise.all([
    agentDataCollector(slice1, 'worker-1'),
    agentDataCollector(slice2, 'worker-2'),
    agentDataCollector(slice3, 'worker-3'),
  ]);
  const allBundles = [...bundles1, ...bundles2, ...bundles3];
  info(`Total bundles ready: ${allBundles.length}`);

  // ── Step 3: Scorer ────────────────────────────────────────────────────
  section('Agent 5 — Scorer (compounder-quality strategy)');
  const scores = await agentScorer(allBundles, 'compounder-quality');

  // ── Step 4: Thesis Writer ─────────────────────────────────────────────
  section('Agent 5b — Thesis Writer (top-3)');
  const theses = await agentThesisWriter(scores);

  // ── Step 5: Supervisor Report ─────────────────────────────────────────
  section('Supervisor — Ranked Universe Report');
  console.log();
  for (let i = 0; i < scores.length; i++) {
    rank(i + 1, scores[i]!);
  }

  console.log(`\n${BOLD}  Top-3 Investment Theses${RESET}`);
  for (const [symbol, thesis] of theses) {
    console.log(`\n  ${BOLD}${symbol}${RESET}`);
    console.log(`  ${DIM}${thesis}${RESET}`);
  }

  // ── Step 6: Factor breakdown for #1 ───────────────────────────────────
  section(`Factor Breakdown — #1 Ranked: ${scores[0]!.symbol}`);
  const breakdown = explainScore(scores[0]!);
  // Print first 20 lines of the markdown breakdown
  const lines = breakdown.split('\n').slice(0, 20);
  for (const line of lines) console.log(`  ${line}`);
  if (breakdown.split('\n').length > 20) info('(breakdown truncated — use explainScore() for full output)');

  // ── Assertions ─────────────────────────────────────────────────────────
  section('Self-checks');
  if (scores.length !== 8) throw new Error(`Expected 8 scored symbols, got ${scores.length}`);
  for (const s of scores) {
    if (s.composite < -1 || s.composite > 1) throw new Error(`${s.symbol}: composite ${s.composite} out of range`);
    if (s.decile < 1 || s.decile > 10) throw new Error(`${s.symbol}: decile ${s.decile} out of range`);
  }
  for (let i = 1; i < scores.length; i++) {
    if (scores[i - 1]!.composite < scores[i]!.composite) {
      throw new Error('Scores not sorted descending');
    }
  }
  if (theses.size !== 3) throw new Error('Expected 3 theses');
  ok('All 8 symbols scored with composites in [-1, +1]');
  ok('Scores sorted descending by composite');
  ok('Deciles assigned in [1, 10]');
  ok('Top-3 theses generated');

  console.log(`\n${GREEN}${BOLD}  Example 120 complete.${RESET}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
