/**
 * Alpaca live broker adapter stub.
 * Throws BrokerNotEnabledError until implemented.
 * Credentials expected in ctx.metadata.alpacaKey + ctx.metadata.alpacaSecret.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { BrokerAdapter } from '../adapter.js';
import type { OrderRequest, OrderResult, Position, AccountBalance } from '../types.js';
import { brokerNotEnabled } from '../types.js';

export class AlpacaBrokerAdapter implements BrokerAdapter {
  async placeOrder(_ctx: ExecutionContext, _order: OrderRequest): Promise<OrderResult> { return brokerNotEnabled('Alpaca'); }
  async cancelOrder(_ctx: ExecutionContext, _orderId: string): Promise<OrderResult> { return brokerNotEnabled('Alpaca'); }
  async getOrder(_ctx: ExecutionContext, _orderId: string): Promise<OrderResult> { return brokerNotEnabled('Alpaca'); }
  async listOrders(_ctx: ExecutionContext): Promise<OrderResult[]> { return brokerNotEnabled('Alpaca'); }
  async getPositions(_ctx: ExecutionContext): Promise<Position[]> { return brokerNotEnabled('Alpaca'); }
  async getBalance(_ctx: ExecutionContext): Promise<AccountBalance> { return brokerNotEnabled('Alpaca'); }
}

export function alpacaBrokerAdapter(): AlpacaBrokerAdapter {
  return new AlpacaBrokerAdapter();
}
