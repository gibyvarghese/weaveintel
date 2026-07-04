/**
 * @weaveintel/tools-broker — paper adapter + MCP server tests
 *
 * Kill-switch and trading-enabled tests use weaveContext({ metadata: { tradingEnabled: true } })
 * passed as the ctx to mcpClient.callTool. The client forwards this via _meta.executionContext,
 * which the server's contextFactory uses to build ctx for each tool handler.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';
import { createBrokerMCPServer, paperBrokerAdapter, PaperBrokerAdapter } from './index.js';

const ALL_TOOL_NAMES = [
  'broker.orders.list',
  'broker.orders.get',
  'broker.orders.place',
  'broker.orders.cancel',
  'broker.positions.list',
  'broker.account.balance',
];

// ── MCP server fixture ────────────────────────────────────────────────────────

describe('@weaveintel/tools-broker (MCP server)', () => {
  let callTool: (name: string, args: Record<string, unknown>, tradingEnabled?: boolean) => Promise<unknown>;
  let listTools: () => Promise<Array<{ name: string }>>;
  let paper: PaperBrokerAdapter;

  beforeEach(async () => {
    paper = paperBrokerAdapter(100_000, { enforceMarketHours: false });
    paper.setPrice('AAPL', 189.30);
    paper.setPrice('MSFT', 415.20);

    const server = createBrokerMCPServer({ adapter: paper });
    const { client, server: transport } = weaveFakeTransport();
    await server.start(transport);
    const mcpClient = weaveMCPClient();
    await mcpClient.connect(client);

    // ctx with tradingEnabled controls the kill-switch
    const disabledCtx  = weaveContext({});
    const enabledCtx   = weaveContext({ metadata: { tradingEnabled: true } });

    callTool = async (name, args, tradingEnabled = false) => {
      const ctx = tradingEnabled ? enabledCtx : disabledCtx;
      const result = await mcpClient.callTool(ctx, { name, arguments: args }) as { content: Array<{ type: string; text: string }> };
      return JSON.parse(result.content[0]!.text);
    };
    listTools = async () => mcpClient.listTools();
  });

  it('exposes all 6 broker tools', async () => {
    const tools = await listTools();
    const names = tools.map(t => t.name);
    for (const expected of ALL_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
  });

  it('broker.account.balance returns initial cash of 100,000', async () => {
    const data = await callTool('broker.account.balance', {}) as { cash: number; currency: string };
    expect(data.currency).toBe('USD');
    expect(data.cash).toBeCloseTo(100_000, 0);
  });

  it('broker.positions.list returns empty array before any trades', async () => {
    const data = await callTool('broker.positions.list', {}) as unknown[];
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(0);
  });

  it('broker.orders.place fills a market buy and reduces cash', async () => {
    const order = await callTool('broker.orders.place', {
      clientOrderId: 'test-buy-001',
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      qty: 10,
    }, true) as { status: string; filledQty: number; averagePrice: number };

    expect(order.status).toBe('filled');
    expect(order.filledQty).toBe(10);
    expect(order.averagePrice).toBeCloseTo(189.30, 1);

    const bal = await callTool('broker.account.balance', {}) as { cash: number };
    expect(bal.cash).toBeCloseTo(100_000 - 10 * 189.30, 0);
  });

  it('broker.orders.place rejects when tradingEnabled is not set (kill-switch)', async () => {
    await expect(
      callTool('broker.orders.place', {
        clientOrderId: 'test-disabled-001',
        symbol: 'AAPL',
        side: 'buy',
        type: 'market',
        qty: 1,
      }, false /* tradingEnabled = false */),
    ).rejects.toThrow();
  });

  it('broker.orders.cancel cancels a pending limit order', async () => {
    const placed = await callTool('broker.orders.place', {
      clientOrderId: 'test-limit-001',
      symbol: 'AAPL',
      side: 'buy',
      type: 'limit',
      qty: 5,
      limitPrice: 50, // well below market — stays pending
    }, true) as { orderId: string; status: string };

    expect(placed.status).toBe('pending');

    const cancelled = await callTool('broker.orders.cancel', { orderId: placed.orderId }, true) as { status: string };
    expect(cancelled.status).toBe('cancelled');
  });

  it('broker.orders.get retrieves an order by ID', async () => {
    const placed = await callTool('broker.orders.place', {
      clientOrderId: 'test-get-001',
      symbol: 'MSFT',
      side: 'buy',
      type: 'market',
      qty: 2,
    }, true) as { orderId: string };

    const fetched = await callTool('broker.orders.get', { orderId: placed.orderId }) as { orderId: string; symbol: string };
    expect(fetched.orderId).toBe(placed.orderId);
    expect(fetched.symbol).toBe('MSFT');
  });

  it('broker.orders.list returns all orders', async () => {
    await callTool('broker.orders.place', {
      clientOrderId: 'test-list-001',
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      qty: 3,
    }, true);

    const orders = await callTool('broker.orders.list', { status: 'all' }) as unknown[];
    expect(orders.length).toBeGreaterThanOrEqual(1);
  });

  it('position shows after a buy', async () => {
    await callTool('broker.orders.place', {
      clientOrderId: 'test-pos-001',
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      qty: 5,
    }, true);

    const positions = await callTool('broker.positions.list', {}) as Array<{ symbol: string; qty: number }>;
    const aapl = positions.find(p => p.symbol === 'AAPL');
    expect(aapl).toBeDefined();
    expect(aapl!.qty).toBe(5);
  });
});

// ── Paper adapter unit tests (direct — no MCP layer) ─────────────────────────

describe('PaperBrokerAdapter — pre-trade risk checks', () => {
  let adapter: PaperBrokerAdapter;
  const ctx = weaveContext({});

  beforeEach(() => {
    adapter = paperBrokerAdapter(50_000, { enforceMarketHours: false });
    adapter.setPrice('AAPL', 200);
  });

  it('rejects duplicate clientOrderId', async () => {
    await adapter.placeOrder(ctx, { clientOrderId: 'dup-001', symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 });
    await expect(
      adapter.placeOrder(ctx, { clientOrderId: 'dup-001', symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 }),
    ).rejects.toThrow('DUPLICATE_CLIENT_ORDER_ID');
  });

  it('rejects when notional exceeds cap', async () => {
    // Default cap is 50,000; 300 shares × $200 = $60,000
    await expect(
      adapter.placeOrder(ctx, { clientOrderId: 'cap-001', symbol: 'AAPL', side: 'buy', type: 'market', qty: 300 }),
    ).rejects.toThrow('NOTIONAL_CAP_EXCEEDED');
  });

  it('rejects symbol not on allow-list', async () => {
    const restricted = paperBrokerAdapter(50_000, { enforceMarketHours: false, allowedSymbols: ['MSFT'] });
    restricted.setPrice('AAPL', 200);
    await expect(
      restricted.placeOrder(ctx, { clientOrderId: 'sym-001', symbol: 'AAPL', side: 'buy', type: 'market', qty: 1 }),
    ).rejects.toThrow('SYMBOL_NOT_ALLOWED');
  });

  it('rejects when daily loss circuit breaker trips', async () => {
    // Use large initial cash (100,000) so 50×$100 = 5% concentration stays below the 20% limit
    const tightAdapter = paperBrokerAdapter(100_000, {
      enforceMarketHours: false,
      dailyLossCircuitBreaker: 100,
    });
    tightAdapter.setPrice('LOST', 100);
    // Buy 50 shares × $100 = $5,000 (5% of $100k — within concentration limit)
    await tightAdapter.placeOrder(ctx, { clientOrderId: 'loss-buy', symbol: 'LOST', side: 'buy', type: 'market', qty: 50 });
    // Drop price to $97: 50 × ($100-$97) = $150 loss > $100 circuit breaker
    tightAdapter.setPrice('LOST', 97);
    await expect(
      tightAdapter.placeOrder(ctx, { clientOrderId: 'loss-check', symbol: 'LOST', side: 'buy', type: 'market', qty: 1 }),
    ).rejects.toThrow('DAILY_LOSS_CIRCUIT_BREAKER');
  });

  it('fills a market buy and updates balance correctly', async () => {
    await adapter.placeOrder(ctx, { clientOrderId: 'fill-001', symbol: 'AAPL', side: 'buy', type: 'market', qty: 10 });
    const balance = await adapter.getBalance(ctx);
    expect(balance.cash).toBeCloseTo(50_000 - 10 * 200, 0);
    const positions = await adapter.getPositions(ctx);
    expect(positions.find(p => p.symbol === 'AAPL')?.qty).toBe(10);
  });

  it('limit order that cannot fill stays pending', async () => {
    const result = await adapter.placeOrder(ctx, {
      clientOrderId: 'lim-001',
      symbol: 'AAPL',
      side: 'buy',
      type: 'limit',
      qty: 5,
      limitPrice: 100, // below $200 market price → won't fill
    });
    expect(result.status).toBe('pending');
    expect(result.filledQty).toBe(0);
  });

  it('limit order that can fill executes at limit price', async () => {
    const result = await adapter.placeOrder(ctx, {
      clientOrderId: 'lim-002',
      symbol: 'AAPL',
      side: 'buy',
      type: 'limit',
      qty: 5,
      limitPrice: 210, // above $200 → fills at limit price
    });
    expect(result.status).toBe('filled');
    expect(result.averagePrice).toBeCloseTo(210, 1);
  });
});
