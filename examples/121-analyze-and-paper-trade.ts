/**
 * Example 121 — Analyze → Score → Thesis → Paper Trade (end-to-end)
 * ─────────────────────────────────────────────────────────────────────────────
 * Demonstrates the full equity-intelligence-to-execution loop:
 *
 *   Phase A — Analysis
 *     1. Fetch market data, news, and alt-data for 5 US tickers
 *     2. Score the universe with 'compounder-quality' strategy
 *     3. Write an equity thesis for the #1 ranked symbol
 *
 *   Phase B — Paper Trading
 *     4. Boot the broker MCP server with PaperBrokerAdapter (no real money)
 *     5. Check account balance and open positions
 *     6. Place a market-buy order for the top-ranked symbol (subject to all
 *        6 pre-trade risk checks — tenant kill-switch, notional cap, etc.)
 *     7. Verify fill, updated balance, and position
 *     8. Place a limit sell to set an exit target, then cancel it
 *
 * ─── Packages used ──────────────────────────────────────────────────────────
 *   @weaveintel/core                — weaveContext
 *   @weaveintel/tools/marketdata   — fixtureMarketDataAdapter
 *   @weaveintel/tools/news         — fixtureNewsAdapter
 *   @weaveintel/tools/altdata      — fixtureAltDataAdapter
 *   @weaveintel/equity-scoring     — scoreUniverse, strategies
 *   @weaveintel/tools/broker       — createBrokerMCPServer, paperBrokerAdapter
 *   @weaveintel/testing            — weaveFakeTransport
 *   @weaveintel/mcp-client         — weaveMCPClient
 *
 * Run: npx tsx examples/121-analyze-and-paper-trade.ts
 */

import { weaveContext, type ExecutionContext } from '@weaveintel/core';
import { fixtureMarketDataAdapter } from '@weaveintel/tools/marketdata';
import { fixtureNewsAdapter } from '@weaveintel/tools/news';
import { fixtureAltDataAdapter } from '@weaveintel/tools/altdata';
import { scoreUniverse, strategies } from '@weaveintel/equity-scoring';
import type { InputBundle, SymbolScore } from '@weaveintel/equity-scoring';
import { createBrokerMCPServer, paperBrokerAdapter } from '@weaveintel/tools/broker';
import type { PaperBrokerAdapter } from '@weaveintel/tools/broker';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';

// ── Console helpers ────────────────────────────────────────────────────────

const BOLD = '\x1b[1m'; const GREEN = '\x1b[32m'; const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m'; const DIM = '\x1b[2m'; const RESET = '\x1b[0m';

function header(t: string) {
  console.log(`\n${BOLD}${'═'.repeat(70)}${RESET}`);
  console.log(`${BOLD}  ${t}${RESET}`);
  console.log(`${BOLD}${'═'.repeat(70)}${RESET}`);
}
function section(t: string) { console.log(`\n${CYAN}  ── ${t} ──${RESET}`); }
function ok(m: string)      { console.log(`${GREEN}  ✓${RESET} ${m}`); }
function info(m: string)    { console.log(`${DIM}  ℹ ${m}${RESET}`); }
function warn(m: string)    { console.log(`${YELLOW}  ⚠${RESET} ${m}`); }

// ── Shared fixtures ────────────────────────────────────────────────────────

const US_SYMBOLS = ['AAPL', 'MSFT', 'GOOGL', 'JNJ', 'XOM'];
const TODAY      = '2026-05-29';
const ONE_YEAR   = '2025-05-29';

// ── Phase A helpers ────────────────────────────────────────────────────────

async function buildBundle(symbol: string): Promise<InputBundle> {
  const md   = fixtureMarketDataAdapter();
  const news = fixtureNewsAdapter();
  const alt  = fixtureAltDataAdapter();
  const ctx  = weaveContext({});

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

function buildThesisSummary(score: SymbolScore): string {
  const top2 = Object.values(score.factors).slice().sort((a, b) => b.score - a.score).slice(0, 2);
  return [
    `${score.symbol} | composite=${score.composite.toFixed(3)} decile=${score.decile}/10`,
    `confidence=${(score.confidence * 100).toFixed(0)}%`,
    `top factors: ${top2.map(f => `${f.category}(${f.score > 0 ? '+' : ''}${f.score.toFixed(2)})`).join(', ')}`,
    score.redFlags.length ? `⚠ red flags: ${score.redFlags.map(f => f.code).join(', ')}` : 'no red flags',
    score.greenFlags.length ? `★ green flags: ${score.greenFlags.map(f => f.code).join(', ')}` : '',
  ].filter(Boolean).join('  |  ');
}

// ── Phase B helpers — MCP broker client ───────────────────────────────────

interface McpCallResult {
  content: Array<{ type: string; text: string }>;
}

async function setupBrokerMcp(paper: PaperBrokerAdapter) {
  const server = createBrokerMCPServer({ adapter: paper });
  const { client, server: transport } = weaveFakeTransport();
  await server.start(transport);
  const mcpClient = weaveMCPClient();
  await mcpClient.connect(client);

  // Two contexts — the client forwards ctx as _meta.executionContext to the server,
  // which the contextFactory uses to build the tool handler's ctx (including metadata).
  const disabledCtx = weaveContext({});
  const enabledCtx  = weaveContext({ metadata: { tradingEnabled: true } });

  // enabled=true routes through enabledCtx so the kill-switch passes.
  // enabled=false (default) uses disabledCtx — mutating tools will reject.
  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    enabled = false,
  ): Promise<unknown> => {
    const ctx = enabled ? enabledCtx : disabledCtx;
    const result = await mcpClient.callTool(ctx, { name, arguments: args }) as McpCallResult;
    return JSON.parse(result.content[0]!.text);
  };

  return { callTool };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  header('Example 121 — Analyze → Score → Thesis → Paper Trade');

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE A — ANALYSIS
  // ─────────────────────────────────────────────────────────────────────────

  section('Phase A.1 — Build InputBundles (fixture adapters, no network)');
  const bundles = await Promise.all(US_SYMBOLS.map(sym => buildBundle(sym)));
  ok(`Built ${bundles.length} InputBundles for: ${US_SYMBOLS.join(', ')}`);

  section('Phase A.2 — Score universe (compounder-quality strategy)');
  const strategy = strategies['compounder-quality']!;
  const scores   = scoreUniverse(bundles, strategy);

  console.log();
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i]!;
    const bar = '█'.repeat(Math.round(Math.max(0, s.composite + 1) * 5));
    console.log(`  ${YELLOW}#${i + 1}${RESET} ${BOLD}${s.symbol.padEnd(8)}${RESET} composite=${s.composite.toFixed(3).padEnd(8)} decile=${s.decile}/10  ${DIM}${bar}${RESET}`);
  }

  const top = scores[0]!;
  ok(`Top-ranked symbol: ${top.symbol} (composite=${top.composite.toFixed(3)})`);

  section('Phase A.3 — Equity thesis for #1 symbol');
  const thesis = buildThesisSummary(top);
  console.log(`\n  ${DIM}${thesis}${RESET}\n`);
  ok(`Thesis generated for ${top.symbol}`);

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE B — PAPER TRADING
  // ─────────────────────────────────────────────────────────────────────────

  section('Phase B.1 — Boot broker MCP server with paper adapter ($100,000 initial cash)');
  const paper = paperBrokerAdapter(100_000, {
    enforceMarketHours: false, // offline demo — skip NYSE hours check
    maxNotionalPerOrder: 50_000,
    maxConcentrationPct: 0.30,
    dailyLossCircuitBreaker: 15_000,
  });

  // Inject live prices from the quote fixture
  const md  = fixtureMarketDataAdapter();
  const ctx = weaveContext({});
  for (const sym of US_SYMBOLS) {
    const quote = await md.getQuote(ctx, sym);
    paper.setPrice(sym, quote.price);
    info(`Injected price ${sym} → $${quote.price.toFixed(2)}`);
  }

  const { callTool } = await setupBrokerMcp(paper);
  ok('Broker MCP server started (paper adapter)');

  section('Phase B.2 — Check initial account balance');
  const balance0 = await callTool('broker.account.balance', {}) as {
    cash: number; equity: number; currency: string;
  };
  ok(`Account: cash=$${balance0.cash.toLocaleString()} equity=$${balance0.equity.toLocaleString()} (${balance0.currency})`);

  section('Phase B.3 — Check open positions (expect none)');
  const positions0 = await callTool('broker.positions.list', {}) as unknown[];
  ok(`Open positions before trade: ${positions0.length}`);
  if (positions0.length !== 0) throw new Error('Expected no open positions before first trade');

  section(`Phase B.4 — Place market buy: 50 shares of ${top.symbol}`);
  const buyQty    = 50;
  const buyResult = await callTool('broker.orders.place', {
    clientOrderId: `coid-buy-${top.symbol}-001`,
    symbol: top.symbol,
    side: 'buy',
    type: 'market',
    qty: buyQty,
  }, true) as {
    orderId: string;
    status: string;
    filledQty: number;
    averagePrice: number | null;
    symbol: string;
  };

  ok(`Order submitted: orderId=${buyResult.orderId}`);
  ok(`Status: ${buyResult.status}  filledQty=${buyResult.filledQty}  avgPrice=$${buyResult.averagePrice?.toFixed(2)}`);

  if (buyResult.status !== 'filled') throw new Error(`Expected filled, got: ${buyResult.status}`);
  if (buyResult.filledQty !== buyQty) throw new Error(`Expected ${buyQty} shares filled`);

  section('Phase B.5 — Verify updated balance and position');
  const balance1 = await callTool('broker.account.balance', {}) as {
    cash: number; portfolioValue: number; equity: number; openPositions: number;
  };
  ok(`Cash after buy: $${balance1.cash.toFixed(2)} (reduced from $${balance0.cash.toFixed(2)})`);
  ok(`Portfolio value: $${balance1.portfolioValue.toFixed(2)}`);
  ok(`Open positions: ${balance1.openPositions}`);

  const positions1 = await callTool('broker.positions.list', {}) as Array<{
    symbol: string; qty: number; averageCost: number; marketValue: number; unrealizedPnl: number;
  }>;
  const pos = positions1.find(p => p.symbol === top.symbol);
  if (!pos) throw new Error(`No position found for ${top.symbol} after buy`);
  ok(`Position: ${pos.qty} shares of ${pos.symbol} @ avg cost $${pos.averageCost.toFixed(2)}`);
  ok(`Market value: $${pos.marketValue.toFixed(2)}  unrealized P&L: $${pos.unrealizedPnl.toFixed(2)}`);

  section('Phase B.6 — Place a limit sell exit order (10% above cost)');
  const exitPrice  = parseFloat((pos.averageCost * 1.10).toFixed(2));
  const sellResult = await callTool('broker.orders.place', {
    clientOrderId: `coid-sell-${top.symbol}-001`,
    symbol: top.symbol,
    side: 'sell',
    type: 'limit',
    qty: buyQty,
    limitPrice: exitPrice,
    timeInForce: 'gtc',
  }, true) as {
    orderId: string;
    status: string;
    symbol: string;
  };
  ok(`Limit sell placed: orderId=${sellResult.orderId} status=${sellResult.status} limitPrice=$${exitPrice}`);
  // Limit is above current market price → stays pending
  if (sellResult.status !== 'pending') {
    warn(`Expected pending limit order, got: ${sellResult.status}`);
  }

  section('Phase B.7 — Cancel the limit sell');
  const cancelled = await callTool('broker.orders.cancel', {
    orderId: sellResult.orderId,
  }, true) as { status: string; orderId: string };
  ok(`Order ${cancelled.orderId} cancelled — status: ${cancelled.status}`);
  if (cancelled.status !== 'cancelled') throw new Error(`Expected cancelled, got: ${cancelled.status}`);

  section('Phase B.8 — List all orders');
  const allOrders = await callTool('broker.orders.list', { status: 'all' }) as Array<{
    clientOrderId: string; symbol: string; side: string; status: string; filledQty: number;
  }>;
  ok(`Total orders placed: ${allOrders.length}`);
  for (const o of allOrders) {
    info(`  ${o.clientOrderId.padEnd(32)} ${o.symbol.padEnd(8)} ${o.side.padEnd(5)} ${o.status.padEnd(10)} filledQty=${o.filledQty}`);
  }

  // ── Tenant kill-switch demonstration ─────────────────────────────────────
  section('Phase B.9 — Kill-switch: reject trade when tradingEnabled is not set');
  let killSwitchFired = false;
  try {
    await callTool('broker.orders.place', {
      clientOrderId: 'coid-blocked-001',
      symbol: 'MSFT',
      side: 'buy',
      type: 'market',
      qty: 1,
      // No enabledMeta() → tradingEnabled not set
    });
  } catch {
    killSwitchFired = true;
    ok('Kill-switch correctly rejected trade (tradingEnabled not set)');
  }
  if (!killSwitchFired) throw new Error('Kill-switch should have rejected the trade');

  // ── Final assertions ──────────────────────────────────────────────────────
  section('Final assertions');
  if (scores.length !== 5) throw new Error(`Expected 5 scored symbols, got ${scores.length}`);
  for (const s of scores) {
    if (s.composite < -1 || s.composite > 1) throw new Error(`Composite out of range: ${s.symbol}`);
  }
  if (balance1.cash >= balance0.cash) throw new Error('Cash should be lower after buying');
  if (balance1.openPositions !== 1) throw new Error('Expected exactly 1 open position');
  ok('All 5 symbols scored with composites in [-1, +1]');
  ok('Cash reduced after buy order filled');
  ok('Limit sell placed, then cancelled successfully');
  ok('Tenant kill-switch enforced on mutating tools');

  console.log(`\n${GREEN}${BOLD}  Example 121 complete — analyze → score → thesis → paper trade verified.${RESET}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
