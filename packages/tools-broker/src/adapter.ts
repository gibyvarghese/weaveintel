/**
 * BrokerAdapter — provider-agnostic contract.
 * All live adapters and the paper adapter implement this interface.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { OrderRequest, OrderResult, Position, AccountBalance } from './types.js';

export interface BrokerAdapter {
  /** Submit an order. Throws PreTradeRejection for risk-check failures. */
  placeOrder(ctx: ExecutionContext, order: OrderRequest): Promise<OrderResult>;

  /** Cancel a previously submitted order by orderId. */
  cancelOrder(ctx: ExecutionContext, orderId: string): Promise<OrderResult>;

  /** Get status of a specific order. */
  getOrder(ctx: ExecutionContext, orderId: string): Promise<OrderResult>;

  /** List all open orders. */
  listOrders(ctx: ExecutionContext, status?: 'open' | 'closed' | 'all'): Promise<OrderResult[]>;

  /** Get all current open positions. */
  getPositions(ctx: ExecutionContext): Promise<Position[]>;

  /** Get account cash and portfolio summary. */
  getBalance(ctx: ExecutionContext): Promise<AccountBalance>;
}
