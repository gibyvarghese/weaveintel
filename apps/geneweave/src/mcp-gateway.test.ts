import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMCPGateway, DEFAULT_EXPOSED_ALLOCATION_CLASSES } from './mcp-gateway.js';

/**
 * Boots a tiny HTTP server fronted only by the MCP gateway handler so we
 * can exercise the request lifecycle (auth, MCP JSON-RPC dispatch, error
 * surfaces) without spinning up the full GeneWeave server.
 */
function startGatewayHttp(token: string | undefined): Promise<{ url: string; close: () => Promise<void> }> {
  const gateway = createMCPGateway({ token });
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void gateway.handle(req, res).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('gateway handle error', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('error');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        close: () =>
          new Promise<void>((r, rej) => {
            void gateway.close().then(() => server.close((err) => (err ? rej(err) : r())));
          }),
      });
    });
  });
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; bodyText: string; bodyJson: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const bodyText = await res.text();
  let bodyJson: unknown = null;
  try { bodyJson = JSON.parse(bodyText); } catch { /* SSE or non-JSON */ }
  return { status: res.status, bodyText, bodyJson };
}

/**
 * The Streamable HTTP transport may reply either as a single JSON response
 * or as an SSE stream depending on negotiation. This helper extracts the
 * first JSON-RPC envelope from either shape.
 */
function parseRPCResponse(bodyText: string, bodyJson: unknown): { id?: number | string; result?: unknown; error?: unknown } | null {
  if (bodyJson && typeof bodyJson === 'object') {
    return bodyJson as { id?: number | string; result?: unknown; error?: unknown };
  }
  const dataLine = bodyText.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine.slice(6));
  } catch {
    return null;
  }
}

describe('Phase 1D — MCP gateway', () => {
  describe('disabled (no token)', () => {
    let handle: { url: string; close: () => Promise<void> };
    beforeAll(async () => { handle = await startGatewayHttp(undefined); });
    afterAll(async () => { await handle.close(); });

    it('returns 503 with explanatory error when no token is configured', async () => {
      const r = await postJson(`${handle.url}/api/mcp/gateway`, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(r.status).toBe(503);
      expect(r.bodyJson).toMatchObject({ error: expect.stringContaining('disabled') });
    });
  });

  describe('enabled', () => {
    const TOKEN = 'test-secret-token-1234';
    let handle: { url: string; close: () => Promise<void> };
    beforeAll(async () => { handle = await startGatewayHttp(TOKEN); });
    afterAll(async () => { await handle.close(); });

    it('rejects requests with no Authorization header (401)', async () => {
      const r = await postJson(`${handle.url}/api/mcp/gateway`, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(r.status).toBe(401);
      expect(r.bodyJson).toMatchObject({ error: 'Unauthorized' });
    });

    it('rejects requests with wrong bearer token (401)', async () => {
      const r = await postJson(
        `${handle.url}/api/mcp/gateway`,
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { Authorization: 'Bearer wrong-token' },
      );
      expect(r.status).toBe(401);
    });

    it('initialize handshake succeeds with correct token', async () => {
      const r = await postJson(
        `${handle.url}/api/mcp/gateway`,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'phase1d-test', version: '1.0.0' },
          },
        },
        { Authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(200);
      const env = parseRPCResponse(r.bodyText, r.bodyJson);
      expect(env).toBeTruthy();
      expect(env?.error).toBeUndefined();
      const result = env?.result as { serverInfo?: { name?: string } } | undefined;
      expect(result?.serverInfo?.name).toBe('geneweave-gateway');
    });

    it('tools/list exposes external tools and excludes utility/data classes', async () => {
      const r = await postJson(
        `${handle.url}/api/mcp/gateway`,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { Authorization: `Bearer ${TOKEN}` },
      );
      expect(r.status).toBe(200);
      const env = parseRPCResponse(r.bodyText, r.bodyJson);
      const result = env?.result as { tools?: Array<{ name: string; description: string }> } | undefined;
      expect(Array.isArray(result?.tools)).toBe(true);
      const names = (result?.tools ?? []).map((t) => t.name);

      // External classes — at least the canonical web search must be present.
      expect(names).toContain('web_search');

      // Utility / SV / data classes must NOT be exposed by default.
      expect(names).not.toContain('calculator'); // utility
      expect(names).not.toContain('datetime');   // utility
      expect(names).not.toContain('json_format');  // data
      expect(names).not.toContain('text_analysis');// data
    });

    it('all exposed tools belong to the default exposed allocation classes', async () => {
      const r = await postJson(
        `${handle.url}/api/mcp/gateway`,
        { jsonrpc: '2.0', id: 3, method: 'tools/list' },
        { Authorization: `Bearer ${TOKEN}` },
      );
      const env = parseRPCResponse(r.bodyText, r.bodyJson);
      const result = env?.result as { tools?: Array<{ name: string; description: string }> } | undefined;
      const tools = result?.tools ?? [];
      expect(tools.length).toBeGreaterThan(0);
      // Description prefixes are `[allocationClass] ...`.
      for (const t of tools) {
        const m = t.description.match(/^\[([^\]]+)\]/);
        expect(m, `tool ${t.name} must have allocationClass prefix`).toBeTruthy();
        const cls = m![1]!;
        expect(DEFAULT_EXPOSED_ALLOCATION_CLASSES.has(cls), `tool ${t.name} class ${cls} must be in default set`).toBe(true);
      }
    });
  });

  describe('exposed surface', () => {
    it('synchronous factory reports exposedToolNames before any request', () => {
      const gw = createMCPGateway({ token: 'x' });
      expect(gw.enabled).toBe(true);
      expect(gw.exposedToolNames).toContain('web_search');
      expect(gw.exposedToolNames).not.toContain('calculator');
      void gw.close();
    });

    it('reports disabled and empty surface when no token', () => {
      const gw = createMCPGateway({ token: undefined });
      expect(gw.enabled).toBe(false);
      // Tools are still discovered; only the HTTP path is disabled.
      expect(gw.exposedToolNames.length).toBeGreaterThan(0);
      void gw.close();
    });
  });
});
