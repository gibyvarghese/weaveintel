/**
 * @weaveintel/tools-broker — MCP server
 *
 * Read-only tools (risk level: 'read-only'):
 *   broker.orders.list        — list orders
 *   broker.orders.get         — get a single order
 *   broker.positions.list     — list open positions
 *   broker.account.balance    — account cash and P&L summary
 *
 * Mutating tools (risk level: 'financial'):
 *   broker.orders.place       — submit an order (all 6 pre-trade checks run inside the adapter)
 *   broker.orders.cancel      — cancel a pending order
 *
 * TENANT KILL-SWITCH: every mutating tool checks ctx.metadata.tradingEnabled === true
 * before calling the adapter. If not set, the tool rejects immediately.
 * The ctx is built by the contextFactory from _meta.executionContext (set by weaveMCPClient).
 *
 * No secrets are stored in this package. Credentials arrive at runtime via
 * _meta.executionContext.metadata.
 */

import { weaveContext } from '@weaveintel/core';
import type { ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveToolDescriptor as describeT } from '@weaveintel/tools';
import type { BrokerAdapter } from './adapter.js';
import { paperBrokerAdapter } from './adapters/paper.js';
import type { OrderRequest } from './types.js';

export interface BrokerMCPServerOptions {
  adapter?: BrokerAdapter;
}

function asText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function tradingEnabledCheck(ctx: ExecutionContext): void {
  if (ctx.metadata?.['tradingEnabled'] !== true) {
    throw new Error('[TRADING_DISABLED] Trading is not enabled for this tenant. Set metadata.tradingEnabled=true to enable.');
  }
}

export function createBrokerMCPServer(opts: BrokerMCPServerOptions = {}) {
  const adapter = opts.adapter ?? paperBrokerAdapter();

  const server = weaveMCPServer(
    { name: 'broker', version: '0.1.0' },
    {
      contextFactory: (params) => {
        const executionContext = (params['_meta'] as { executionContext?: Partial<ExecutionContext> } | undefined)?.executionContext;
        return weaveContext(executionContext ?? {});
      },
    },
  );

  // ── Risk descriptors ─────────────────────────────────────────────────────────
  describeT('broker.orders.list',    'List orders for the current account', 'read-only');
  describeT('broker.orders.get',     'Get details of a specific order by ID', 'read-only');
  describeT('broker.positions.list', 'List all open positions with P&L', 'read-only');
  describeT('broker.account.balance','Get account cash, equity, and day P&L', 'read-only');
  describeT('broker.orders.place',   'Submit a new order (subject to pre-trade risk checks)', 'financial');
  describeT('broker.orders.cancel',  'Cancel a pending order by ID', 'financial');

  // ── Read-only tools ───────────────────────────────────────────────────────────

  server.addTool({
    name: 'broker.orders.list',
    description: 'List orders for the current account. Filter by status: open, closed, or all.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'closed', 'all'], default: 'all', description: 'Filter by order status' },
      },
    },
  }, async (ctx, args) => {
    const status = (args['status'] as 'open' | 'closed' | 'all' | undefined) ?? 'all';
    return asText(await adapter.listOrders(ctx, status));
  });

  server.addTool({
    name: 'broker.orders.get',
    description: 'Get details of a specific order by its orderId.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: 'The broker-assigned order ID' },
      },
      required: ['orderId'],
    },
  }, async (ctx, args) => {
    return asText(await adapter.getOrder(ctx, args['orderId'] as string));
  });

  server.addTool({
    name: 'broker.positions.list',
    description: 'List all open positions with current market value and unrealized P&L.',
    inputSchema: { type: 'object', properties: {} },
  }, async (ctx) => {
    return asText(await adapter.getPositions(ctx));
  });

  server.addTool({
    name: 'broker.account.balance',
    description: 'Get account summary: cash, portfolio value, equity, buying power, and day P&L.',
    inputSchema: { type: 'object', properties: {} },
  }, async (ctx) => {
    return asText(await adapter.getBalance(ctx));
  });

  // ── Mutating tools (financial risk level + tenant kill-switch) ──────────────

  server.addTool({
    name: 'broker.orders.place',
    description: 'Submit a new order. Enforces all pre-trade risk checks. Requires tradingEnabled=true in execution context metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        clientOrderId: { type: 'string', description: 'Idempotency key — unique per order attempt' },
        symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL)' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        type: { type: 'string', enum: ['market', 'limit', 'stop', 'stop_limit'] },
        qty: { type: 'number', description: 'Number of shares' },
        limitPrice: { type: 'number', description: 'Required for limit and stop_limit orders' },
        stopPrice: { type: 'number', description: 'Required for stop and stop_limit orders' },
        timeInForce: { type: 'string', enum: ['day', 'gtc', 'ioc', 'fok'], default: 'day' },
      },
      required: ['clientOrderId', 'symbol', 'side', 'type', 'qty'],
    },
  }, async (ctx, args) => {
    // ── TENANT KILL-SWITCH ────────────────────────────────────────────────────
    tradingEnabledCheck(ctx);

    const order: OrderRequest = {
      clientOrderId: args['clientOrderId'] as string,
      symbol: args['symbol'] as string,
      side: args['side'] as 'buy' | 'sell',
      type: args['type'] as 'market' | 'limit' | 'stop' | 'stop_limit',
      qty: args['qty'] as number,
      limitPrice: args['limitPrice'] as number | undefined,
      stopPrice: args['stopPrice'] as number | undefined,
      timeInForce: (args['timeInForce'] as 'day' | 'gtc' | 'ioc' | 'fok' | undefined) ?? 'day',
    };

    return asText(await adapter.placeOrder(ctx, order));
  });

  server.addTool({
    name: 'broker.orders.cancel',
    description: 'Cancel a pending order by its orderId. Requires tradingEnabled=true in execution context metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: 'The broker-assigned order ID to cancel' },
      },
      required: ['orderId'],
    },
  }, async (ctx, args) => {
    // ── TENANT KILL-SWITCH ────────────────────────────────────────────────────
    tradingEnabledCheck(ctx);

    return asText(await adapter.cancelOrder(ctx, args['orderId'] as string));
  });

  return server;
}
