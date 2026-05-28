/**
 * Zerodha Kite live broker adapter stub.
 * Throws BrokerNotEnabledError until implemented.
 * Credentials expected in ctx.metadata.zerodhaKey + ctx.metadata.zerodhaAccessToken.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { BrokerAdapter } from '../adapter.js';
import type { OrderRequest, OrderResult, Position, AccountBalance } from '../types.js';
import { brokerNotEnabled } from '../types.js';

export class ZerodhaBrokerAdapter implements BrokerAdapter {
  async placeOrder(_ctx: ExecutionContext, _order: OrderRequest): Promise<OrderResult> { return brokerNotEnabled('Zerodha'); }
  async cancelOrder(_ctx: ExecutionContext, _orderId: string): Promise<OrderResult> { return brokerNotEnabled('Zerodha'); }
  async getOrder(_ctx: ExecutionContext, _orderId: string): Promise<OrderResult> { return brokerNotEnabled('Zerodha'); }
  async listOrders(_ctx: ExecutionContext): Promise<OrderResult[]> { return brokerNotEnabled('Zerodha'); }
  async getPositions(_ctx: ExecutionContext): Promise<Position[]> { return brokerNotEnabled('Zerodha'); }
  async getBalance(_ctx: ExecutionContext): Promise<AccountBalance> { return brokerNotEnabled('Zerodha'); }
}

export function zerodhaBrokerAdapter(): ZerodhaBrokerAdapter {
  return new ZerodhaBrokerAdapter();
}
