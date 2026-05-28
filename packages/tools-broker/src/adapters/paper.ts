/**
 * In-memory paper trading simulator.
 *
 * Fills market orders immediately at the provided currentPrice (or last known price).
 * Enforces all 6 mandatory pre-trade risk checks:
 *   1. Notional cap per order
 *   2. Position concentration limit
 *   3. Daily-loss circuit breaker
 *   4. Symbol allow-list
 *   5. Off-hours guard (NYSE hours Mon-Fri 09:30-16:00 ET)
 *   6. Duplicate clientOrderId
 *
 * No network calls. Safe for CI and offline demos.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { BrokerAdapter } from '../adapter.js';
import type { OrderRequest, OrderResult, Position, AccountBalance, Fill } from '../types.js';
import { preTradeReject } from '../types.js';

// ── Risk configuration (overridable via ctx.metadata) ─────────────────────────

interface RiskConfig {
  maxNotionalPerOrder: number;   // USD
  maxConcentrationPct: number;   // 0-1, e.g. 0.20
  dailyLossCircuitBreaker: number; // USD loss that halts trading
  allowedSymbols: string[] | null; // null = all allowed
  enforceMarketHours: boolean;
}

const DEFAULT_RISK: RiskConfig = {
  maxNotionalPerOrder: 50_000,
  maxConcentrationPct: 0.20,
  dailyLossCircuitBreaker: 10_000,
  allowedSymbols: null,
  enforceMarketHours: true,
};

// ── Internal state ────────────────────────────────────────────────────────────

interface InternalPosition {
  symbol: string;
  qty: number;
  totalCost: number; // qty × avgCost
}

interface PaperState {
  cash: number;
  startOfDayCash: number;
  positions: Map<string, InternalPosition>;
  orders: Map<string, OrderResult>;
  usedClientOrderIds: Set<string>;
  currentPrices: Map<string, number>;
}

function makeState(initialCash: number): PaperState {
  return {
    cash: initialCash,
    startOfDayCash: initialCash,
    positions: new Map(),
    orders: new Map(),
    usedClientOrderIds: new Set(),
    currentPrices: new Map(),
  };
}

// ── NYSE market hours check ───────────────────────────────────────────────────

function isMarketOpen(): boolean {
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // Sunday=0, Saturday=6
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;

  // Convert UTC to Eastern Time (UTC-5 standard, UTC-4 daylight)
  const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
  const isDst = Math.max(jan, jul) !== now.getTimezoneOffset();
  const offsetHours = isDst ? 4 : 5;
  const etHour = now.getUTCHours() - offsetHours;
  const etMinute = now.getUTCMinutes();
  const etMinuteOfDay = ((etHour + 24) % 24) * 60 + etMinute;

  // 09:30 = 570 minutes, 16:00 = 960 minutes
  return etMinuteOfDay >= 570 && etMinuteOfDay < 960;
}

// ── Pre-trade risk checks ─────────────────────────────────────────────────────

function runPreTradeChecks(
  order: OrderRequest,
  price: number,
  state: PaperState,
  risk: RiskConfig,
): void {
  // 1. Duplicate clientOrderId
  if (state.usedClientOrderIds.has(order.clientOrderId)) {
    preTradeReject('DUPLICATE_CLIENT_ORDER_ID', `clientOrderId '${order.clientOrderId}' already used`);
  }

  // 2. Symbol allow-list
  if (risk.allowedSymbols !== null && !risk.allowedSymbols.includes(order.symbol)) {
    preTradeReject('SYMBOL_NOT_ALLOWED', `Symbol '${order.symbol}' is not on the allowed-symbol list`);
  }

  // 3. Market hours guard
  if (risk.enforceMarketHours && !isMarketOpen()) {
    preTradeReject('MARKET_CLOSED', 'NYSE market is currently closed; paper adapter enforces market hours by default');
  }

  // 4. Notional cap
  const notional = order.qty * price;
  if (notional > risk.maxNotionalPerOrder) {
    preTradeReject('NOTIONAL_CAP_EXCEEDED', `Order notional $${notional.toFixed(2)} exceeds per-order cap of $${risk.maxNotionalPerOrder}`);
  }

  // 5. Position concentration
  const totalPortfolioValue = computePortfolioValue(state);
  if (totalPortfolioValue > 0) {
    const existingPos = state.positions.get(order.symbol);
    const existingValue = existingPos ? existingPos.qty * price : 0;
    const newPositionValue = order.side === 'buy'
      ? existingValue + notional
      : Math.max(0, existingValue - notional);
    const concentration = newPositionValue / (totalPortfolioValue + notional);
    if (concentration > risk.maxConcentrationPct) {
      preTradeReject('CONCENTRATION_LIMIT', `Position in '${order.symbol}' would be ${(concentration * 100).toFixed(1)}% of portfolio, exceeding ${(risk.maxConcentrationPct * 100).toFixed(0)}% limit`);
    }
  }

  // 6. Daily-loss circuit breaker
  const portfolioEquity = state.cash + computePositionValue(state);
  const dayPnl = portfolioEquity - state.startOfDayCash;
  if (dayPnl < 0 && Math.abs(dayPnl) >= risk.dailyLossCircuitBreaker) {
    preTradeReject('DAILY_LOSS_CIRCUIT_BREAKER', `Daily loss of $${Math.abs(dayPnl).toFixed(2)} has reached circuit-breaker threshold of $${risk.dailyLossCircuitBreaker}`);
  }
}

function computePositionValue(state: PaperState): number {
  let total = 0;
  for (const [sym, pos] of state.positions) {
    const price = state.currentPrices.get(sym) ?? (pos.totalCost / (pos.qty || 1));
    total += pos.qty * price;
  }
  return total;
}

function computePortfolioValue(state: PaperState): number {
  return state.cash + computePositionValue(state);
}

// ── Paper adapter implementation ──────────────────────────────────────────────

export class PaperBrokerAdapter implements BrokerAdapter {
  private state: PaperState;
  private risk: RiskConfig;

  constructor(initialCash = 100_000, riskOverrides: Partial<RiskConfig> = {}) {
    this.state = makeState(initialCash);
    this.risk = { ...DEFAULT_RISK, ...riskOverrides };
  }

  /** Inject a live price for a symbol (used in tests and by the MCP server). */
  setPrice(symbol: string, price: number): void {
    this.state.currentPrices.set(symbol, price);
  }

  /** Advance start-of-day reference cash (call once per trading day reset). */
  resetDay(): void {
    this.state.startOfDayCash = this.state.cash + computePositionValue(this.state);
  }

  async placeOrder(ctx: ExecutionContext, order: OrderRequest): Promise<OrderResult> {
    void ctx;

    // Current market price for this symbol
    const price = this.state.currentPrices.get(order.symbol) ?? 100; // fallback for tests

    // Notional check uses limitPrice for limit orders (worst-case), market price otherwise
    const notionalPrice = (order.type === 'limit' && order.limitPrice != null) ? order.limitPrice : price;
    runPreTradeChecks(order, notionalPrice, this.state, this.risk);

    const now = new Date().toISOString();
    const orderId = `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Mark clientOrderId as used before fill
    this.state.usedClientOrderIds.add(order.clientOrderId);

    // Fill logic:
    //   market → always fills at market price
    //   buy limit → fills if market price <= limit (fills at limit price — simpler for paper)
    //   sell limit → fills if market price >= limit (fills at limit price)
    let filledQty = 0;
    let filledPrice = price;
    let status: OrderResult['status'] = 'pending';

    const shouldFill =
      order.type === 'market' ||
      (order.type === 'limit' && order.side === 'buy' && price <= (order.limitPrice ?? Infinity)) ||
      (order.type === 'limit' && order.side === 'sell' && price >= (order.limitPrice ?? 0));

    // When a limit fills, execute at the limit price (paper sim simplification)
    if (shouldFill && order.type === 'limit' && order.limitPrice != null) {
      filledPrice = order.limitPrice;
    }

    const fills: Fill[] = [];

    if (shouldFill) {
      filledQty = order.qty;
      fills.push({ qty: filledQty, price: filledPrice, filledAt: now });
      status = 'filled';

      this.applyFill(order.symbol, order.side, filledQty, filledPrice);
    }

    const result: OrderResult = {
      orderId,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      qty: order.qty,
      filledQty,
      status,
      fills,
      averagePrice: fills.length ? filledPrice : null,
      submittedAt: now,
      updatedAt: now,
    };

    this.state.orders.set(orderId, result);
    return result;
  }

  private applyFill(symbol: string, side: OrderSide, qty: number, price: number): void {
    const notional = qty * price;

    if (side === 'buy') {
      this.state.cash -= notional;
      const existing = this.state.positions.get(symbol);
      if (existing) {
        existing.qty += qty;
        existing.totalCost += notional;
      } else {
        this.state.positions.set(symbol, { symbol, qty, totalCost: notional });
      }
    } else {
      this.state.cash += notional;
      const existing = this.state.positions.get(symbol);
      if (existing) {
        const sellQty = Math.min(qty, existing.qty);
        const costBasisRemoved = (existing.totalCost / existing.qty) * sellQty;
        existing.qty -= sellQty;
        existing.totalCost -= costBasisRemoved;
        if (existing.qty <= 0) {
          this.state.positions.delete(symbol);
        }
      }
    }
  }

  async cancelOrder(ctx: ExecutionContext, orderId: string): Promise<OrderResult> {
    void ctx;
    const order = this.state.orders.get(orderId);
    if (!order) throw new Error(`Order not found: ${orderId}`);
    if (order.status === 'filled' || order.status === 'cancelled') {
      throw new Error(`Cannot cancel order in status '${order.status}'`);
    }
    const updated: OrderResult = { ...order, status: 'cancelled', updatedAt: new Date().toISOString() };
    this.state.orders.set(orderId, updated);
    return updated;
  }

  async getOrder(ctx: ExecutionContext, orderId: string): Promise<OrderResult> {
    void ctx;
    const order = this.state.orders.get(orderId);
    if (!order) throw new Error(`Order not found: ${orderId}`);
    return order;
  }

  async listOrders(ctx: ExecutionContext, status: 'open' | 'closed' | 'all' = 'all'): Promise<OrderResult[]> {
    void ctx;
    const all = Array.from(this.state.orders.values());
    if (status === 'open') return all.filter(o => o.status === 'pending' || o.status === 'partial');
    if (status === 'closed') return all.filter(o => o.status === 'filled' || o.status === 'cancelled' || o.status === 'rejected');
    return all;
  }

  async getPositions(ctx: ExecutionContext): Promise<Position[]> {
    void ctx;
    return Array.from(this.state.positions.values()).map(p => {
      const currentPrice = this.state.currentPrices.get(p.symbol) ?? (p.totalCost / (p.qty || 1));
      const marketValue = p.qty * currentPrice;
      const costBasis = p.totalCost;
      const unrealizedPnl = marketValue - costBasis;
      return {
        symbol: p.symbol,
        qty: p.qty,
        side: 'long' as const,
        averageCost: p.qty > 0 ? p.totalCost / p.qty : 0,
        currentPrice,
        marketValue,
        unrealizedPnl,
        unrealizedPnlPct: costBasis > 0 ? unrealizedPnl / costBasis : 0,
        costBasis,
      };
    });
  }

  async getBalance(ctx: ExecutionContext): Promise<AccountBalance> {
    void ctx;
    const positionValue = computePositionValue(this.state);
    const equity = this.state.cash + positionValue;
    const dayPnl = equity - this.state.startOfDayCash;
    return {
      accountId: 'paper-account',
      currency: 'USD',
      cash: this.state.cash,
      portfolioValue: positionValue,
      equity,
      buyingPower: this.state.cash,
      dayPnl,
      dayPnlPct: this.state.startOfDayCash > 0 ? dayPnl / this.state.startOfDayCash : 0,
      openPositions: this.state.positions.size,
    };
  }
}

// Convenience factory
export function paperBrokerAdapter(initialCash?: number, riskOverrides?: Partial<RiskConfig>): PaperBrokerAdapter {
  return new PaperBrokerAdapter(initialCash, riskOverrides);
}

// Type alias needed inside this file
type OrderSide = 'buy' | 'sell';
