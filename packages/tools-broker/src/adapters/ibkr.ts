/**
 * Interactive Brokers (IBKR) live broker adapter stub.
 * Throws BrokerNotEnabledError until implemented.
 * Credentials expected in ctx.metadata.ibkrClientId + ctx.metadata.ibkrToken.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { BrokerAdapter } from '../adapter.js';
import type { OrderRequest, OrderResult, Position, AccountBalance } from '../types.js';
import { brokerNotEnabled } from '../types.js';

export class IbkrBrokerAdapter implements BrokerAdapter {
  async placeOrder(_ctx: ExecutionContext, _order: OrderRequest): Promise<OrderResult> { return brokerNotEnabled('IBKR'); }
  async cancelOrder(_ctx: ExecutionContext, _orderId: string): Promise<OrderResult> { return brokerNotEnabled('IBKR'); }
  async getOrder(_ctx: ExecutionContext, _orderId: string): Promise<OrderResult> { return brokerNotEnabled('IBKR'); }
  async listOrders(_ctx: ExecutionContext): Promise<OrderResult[]> { return brokerNotEnabled('IBKR'); }
  async getPositions(_ctx: ExecutionContext): Promise<Position[]> { return brokerNotEnabled('IBKR'); }
  async getBalance(_ctx: ExecutionContext): Promise<AccountBalance> { return brokerNotEnabled('IBKR'); }
}

export function ibkrBrokerAdapter(): IbkrBrokerAdapter {
  return new IbkrBrokerAdapter();
}
