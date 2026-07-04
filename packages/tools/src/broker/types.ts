/**
 * Normalized types for the broker adapter layer.
 * All monetary values are in the account's base currency unless noted.
 */

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit';
export type OrderStatus = 'pending' | 'filled' | 'partial' | 'cancelled' | 'rejected';
export type TimeInForce = 'day' | 'gtc' | 'ioc' | 'fok';

export interface OrderRequest {
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  qty: number;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce?: TimeInForce;
}

export interface Fill {
  qty: number;
  price: number;
  filledAt: string; // ISO timestamp
}

export interface OrderResult {
  orderId: string;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  qty: number;
  filledQty: number;
  status: OrderStatus;
  fills: Fill[];
  averagePrice: number | null;
  submittedAt: string;
  updatedAt: string;
  rejectionReason?: string;
}

export interface Position {
  symbol: string;
  qty: number;
  side: 'long' | 'short';
  averageCost: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  costBasis: number;
}

export interface AccountBalance {
  accountId: string;
  currency: string;
  cash: number;
  portfolioValue: number;
  equity: number;
  buyingPower: number;
  dayPnl: number;
  dayPnlPct: number;
  openPositions: number;
}

export interface BrokerNotEnabledError extends Error {
  code: 'BROKER_NOT_ENABLED';
}

export interface PreTradeRejection extends Error {
  code:
    | 'NOTIONAL_CAP_EXCEEDED'
    | 'CONCENTRATION_LIMIT'
    | 'DAILY_LOSS_CIRCUIT_BREAKER'
    | 'SYMBOL_NOT_ALLOWED'
    | 'MARKET_CLOSED'
    | 'DUPLICATE_CLIENT_ORDER_ID'
    | 'TRADING_DISABLED';
  detail: string;
}

export function brokerNotEnabled(name: string): never {
  const err = new Error(`${name} broker adapter is not enabled in this deployment`) as BrokerNotEnabledError & Error;
  err.code = 'BROKER_NOT_ENABLED';
  throw err;
}

export function preTradeReject(code: PreTradeRejection['code'], detail: string): never {
  const err = new Error(`[${code}] ${detail}`) as PreTradeRejection & Error;
  err.code = code;
  err.detail = detail;
  throw err;
}
