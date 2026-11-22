import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { ActionExecutionContext, AttentionAction } from '@weaveintel/live-agents';
import type { ExecutionContext } from '@weaveintel/core';
import type { HandlerContext } from '../handler-registry.js';
import { externalMcpToolHandler } from './external-mcp-tool.js';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

function run(url: string, extras: Partial<HandlerContext> = {}, config: Record<string, unknown> = {}) {
  const context: HandlerContext = {
    binding: { id: 'binding', agentId: 'agent', handlerKind: 'external.mcp-tool', config: {
      mcp_server_url: url, tool_name: 'test', headers: { Authorization: 'Bearer test-token' }, ...config,
    } },
    agent: { id: 'agent', meshId: 'mesh', roleKey: 'worker', name: 'Worker' },
    log: () => {},
    ...extras,
  };
  const execCtx = {
    agent: { id: 'agent' },
    stateStore: {
      listMessagesForRecipient: async () => [{
        id: 'message', kind: 'TASK', status: 'DELIVERED', body: '{"query":"test"}',
        createdAt: '2026-01-01T00:00:00Z',
      }],
    },
  } as unknown as ActionExecutionContext;
  return externalMcpToolHandler.factory(context)(
    { type: 'StartTask', backlogItemId: 'test' } as AttentionAction & { type: 'StartTask' },
    execCtx,
    {} as ExecutionContext,
  );
}

describe('external MCP outbound policy', () => {
  it('blocks metadata and ignores a policy in the database binding', async () => {
    await expect(run('https://169.254.169.254/latest', {}, {
      mcpOutboundPolicy: { allowPrivateNetwork: true, allowInsecureHttp: true },
    })).rejects.toThrow(/blocked outbound host/i);
    await expect(run('http://10.1.2.3/tools', {}, {
      mcpOutboundPolicy: { allowPrivateNetwork: true, allowInsecureHttp: true },
    })).rejects.toThrow(/non-HTTPS/i);
    const trusted = { allowPrivateNetwork: true, allowInsecureHttp: true };
    await expect(run('http://169.254.169.254/latest', { mcpOutboundPolicy: trusted }))
      .rejects.toThrow(/blocked outbound host/i);
  });

  it('permits a host-authorized private HTTP endpoint, but not without both opt-ins', async () => {
    let calls = 0;
    const server = createServer((req, res) => {
      calls++;
      expect(req.headers.authorization).toBe('Bearer test-token');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        jsonrpc: '2.0', id: '1', result: { content: [{ type: 'text', text: 'ok' }] },
      }));
    });
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/tools`;
    const trusted = { allowLoopback: false, allowPrivateNetwork: true, allowInsecureHttp: true, allowedHosts: ['127.0.0.1'] };
    try {
      await expect(run(url, { mcpOutboundPolicy: { ...trusted, allowInsecureHttp: false } })).rejects.toThrow(/non-HTTPS/i);
      await expect(run(url, { mcpOutboundPolicy: { ...trusted, allowPrivateNetwork: false } })).rejects.toThrow(/private network|loopback host is not allowed/i); // core 0.3 names loopback separately
      expect(calls).toBe(0);
      await expect(run(url, { mcpOutboundPolicy: trusted })).resolves.toMatchObject({ completed: true });
      expect(calls).toBe(1);
    } finally {
      await close(server);
    }
  });

  it('rejects cross-origin redirects without forwarding credentials or task data', async () => {
    let forwarded = 0;
    const target = createServer((_req, res) => { forwarded++; res.writeHead(200).end(); });
    const targetPort = await listen(target);
    const source = createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/tools` }).end();
    });
    const sourcePort = await listen(source);
    try {
      const policy = { allowLoopback: true, allowCrossOriginRedirects: true };
      await expect(run(`http://127.0.0.1:${sourcePort}/tools`, { mcpOutboundPolicy: policy }))
        .rejects.toThrow(/cross-origin redirect/i);
      expect(forwarded).toBe(0);
    } finally {
      await close(source);
      await close(target);
    }
  });

  it('follows same-origin redirects while retaining the MCP request', async () => {
    let received: { method?: string; authorization?: string; body: string } | undefined;
    const server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(307, { location: '/tools' }).end();
        return;
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        received = { method: req.method, authorization: req.headers.authorization, body };
        res.writeHead(200).end(JSON.stringify({
          jsonrpc: '2.0', id: '1', result: { content: [{ type: 'text', text: 'ok' }] },
        }));
      });
    });
    const port = await listen(server);
    try {
      // A loopback MCP server is reached only when the host allows it (core 0.3: loopback is no longer a default).
      await expect(run(`http://127.0.0.1:${port}/redirect`, { mcpOutboundPolicy: { allowLoopback: true } })).resolves.toMatchObject({ completed: true });
      expect(received).toMatchObject({ method: 'POST', authorization: 'Bearer test-token' });
      expect(JSON.parse(received!.body)).toMatchObject({
        method: 'tools/call', params: { name: 'test', arguments: { query: 'test' } },
      });
    } finally {
      await close(server);
    }
  });
});
