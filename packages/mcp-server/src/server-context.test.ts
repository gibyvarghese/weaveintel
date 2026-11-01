/**
 * The MCP server needs a caller identity from the transport (platform-architecture §7.4 item 3;
 * GAPS G-WI-10).
 *
 * Before this fix `weaveMCPServer` ran every call with an anonymous `weaveContext()` when no
 * `contextFactory` was given, and a factory that was given was fed the caller's own JSON-RPC
 * params, so a caller could claim any identity by sending it.
 */
import { describe, expect, it } from 'vitest';
import type { ExecutionContext, MCPTransport } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import { MCPServerConfigError, weaveMCPServer } from './server.js';

/** An in-memory transport: `deliver` plays the client, `sent` records the server's replies. */
function memoryTransport() {
  let handler: ((m: unknown) => void) | undefined;
  const sent: Array<Record<string, unknown>> = [];
  const transport: MCPTransport = {
    type: 'stdio',
    async send(m) {
      sent.push(m as Record<string, unknown>);
    },
    onMessage(h) {
      handler = h;
    },
    async close() {},
  };
  return {
    transport,
    sent,
    async deliver(message: Record<string, unknown>) {
      handler?.(message);
      for (let i = 0; i < 50 && !sent.some((s) => s['id'] === message['id']); i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return sent.find((s) => s['id'] === message['id']);
    },
  };
}

function callTool(id: number, params: Record<string, unknown>) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'whoami', arguments: {}, ...params } };
}

describe('weaveMCPServer caller identity', () => {
  it('refuses to build without a contextFactory (G-WI-10)', () => {
    expect(() =>
      // A JS caller (or a cast) that leaves the factory out must not get an anonymous server.
      weaveMCPServer({ name: 's', version: '1' }, {} as never),
    ).toThrow(MCPServerConfigError);
    expect(() => weaveMCPServer({ name: 's', version: '1' }, undefined as never)).toThrow(MCPServerConfigError);
  });

  it('never hands caller-supplied params to the contextFactory', async () => {
    const seen: unknown[] = [];
    const server = weaveMCPServer(
      { name: 's', version: '1' },
      {
        contextFactory(request) {
          seen.push(request);
          return weaveContext({ userId: 'verified-user', tenantId: 't1' });
        },
      },
    );
    let ran: ExecutionContext | undefined;
    server.addTool(
      { name: 'whoami', description: 'returns the caller', inputSchema: { type: 'object', properties: {} } },
      async (ctx) => {
        ran = ctx;
        return { content: [{ type: 'text', text: String(ctx.userId) }] };
      },
    );
    const t = memoryTransport();
    await server.start(t.transport);
    const reply = await t.deliver(callTool(1, { arguments: { userId: 'attacker' }, _meta: { tenantId: 'victim', auth: 'forged' } }));
    expect(reply?.['result']).toBeDefined();
    expect(ran?.userId).toBe('verified-user');
    expect(ran?.tenantId).toBe('t1');
    // The factory saw transport facts only, never the caller's params.
    const flat = JSON.stringify(seen);
    expect(flat).not.toContain('attacker');
    expect(flat).not.toContain('victim');
    expect(flat).not.toContain('forged');
  });

  it('refuses the call when the contextFactory rejects the caller', async () => {
    let ran = false;
    const server = weaveMCPServer(
      { name: 's', version: '1' },
      {
        contextFactory() {
          throw new Error('no verified note');
        },
      },
    );
    server.addTool(
      { name: 'whoami', description: 'returns the caller', inputSchema: { type: 'object', properties: {} } },
      async () => {
        ran = true;
        return { content: [{ type: 'text', text: 'x' }] };
      },
    );
    const t = memoryTransport();
    await server.start(t.transport);
    const reply = await t.deliver(callTool(2, {}));
    expect(ran).toBe(false);
    expect(reply?.['error']).toBeDefined();
    // The refusal does not echo the factory's internal reason to the caller.
    expect(JSON.stringify(reply)).not.toContain('no verified note');
  });

  it('refuses listing tools when the caller is not authenticated', async () => {
    const server = weaveMCPServer(
      { name: 's', version: '1' },
      {
        contextFactory() {
          throw new Error('unauthenticated');
        },
      },
    );
    const t = memoryTransport();
    await server.start(t.transport);
    const reply = await t.deliver({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    expect(reply?.['error']).toBeDefined();
  });
});

describe('callerAssertedMCPContext', () => {
  it('builds the context from _meta.executionContext on a stdio transport', async () => {
    const { callerAssertedMCPContext } = await import('./server.js');
    const server = weaveMCPServer({ name: 's', version: '1' }, { contextFactory: callerAssertedMCPContext });
    let ran: ExecutionContext | undefined;
    server.addTool(
      { name: 'whoami', description: 'returns the caller', inputSchema: { type: 'object', properties: {} } },
      async (ctx) => {
        ran = ctx;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    );
    const t = memoryTransport();
    await server.start(t.transport);
    await t.deliver(callTool(4, { _meta: { executionContext: { userId: 'local-agent' } } }));
    expect(ran?.userId).toBe('local-agent');
  });

  it('refuses to start on a network transport', async () => {
    const { callerAssertedMCPContext } = await import('./server.js');
    const server = weaveMCPServer({ name: 's', version: '1' }, { contextFactory: callerAssertedMCPContext });
    const t = memoryTransport();
    await expect(server.start({ ...t.transport, type: 'http' })).rejects.toThrow(MCPServerConfigError);
  });
});
