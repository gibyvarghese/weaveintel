import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMCPGateway,
  DEFAULT_EXPOSED_ALLOCATION_CLASSES,
  registerMCPGatewayInCatalog,
  loadGatewayConfigFromCatalog,
  MCP_GATEWAY_TOOL_KEY,
  MCP_GATEWAY_CREDENTIAL_NAME,
  MCP_GATEWAY_DEFAULT_ENV_VAR,
} from './mcp-gateway.js';
import { createDatabaseAdapter } from './db.js';
import {
  InMemoryToolPolicyResolver,
  type ToolAuditEmitter,
} from '@weaveintel/tools';
import type { Tool, ToolAuditEvent } from '@weaveintel/core';

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

  describe('self-registration in tool_catalog', () => {
    function makeTempDbPath(): { dir: string; dbPath: string } {
      const dir = mkdtempSync(join(tmpdir(), 'gw-mcp-cat-'));
      return { dir, dbPath: join(dir, 'test.db') };
    }

    it('upserts a catalog row + credential row idempotently', async () => {
      const { dir, dbPath } = makeTempDbPath();
      const db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
      try {
        const first = await registerMCPGatewayInCatalog(db);
        expect(first.catalogId).toMatch(/^[0-9a-f-]{36}$/);
        expect(first.credentialId).toMatch(/^[0-9a-f-]{36}$/);

        const catalog = await db.getToolCatalogByKey(MCP_GATEWAY_TOOL_KEY);
        expect(catalog).not.toBeNull();
        expect(catalog!.source).toBe('mcp');
        expect(catalog!.allocation_class).toBe('gateway');
        expect(catalog!.credential_id).toBe(first.credentialId);
        expect(catalog!.enabled).toBe(1);

        const config = JSON.parse(catalog!.config ?? '{}') as {
          endpoint: string;
          exposed_classes: string[];
          exposed_tool_keys: string[];
          auth_scheme: string;
        };
        expect(config.endpoint).toBe('/api/mcp/gateway');
        expect(config.auth_scheme).toBe('Bearer');
        // exposed_classes must match the default exposed set, sorted.
        expect(config.exposed_classes).toEqual([...DEFAULT_EXPOSED_ALLOCATION_CLASSES].sort());
        // exposed_tool_keys must include at least one external tool and exclude utility ones.
        expect(config.exposed_tool_keys).toContain('web_search');
        expect(config.exposed_tool_keys).not.toContain('calculator');

        const cred = await db.getToolCredential(first.credentialId);
        expect(cred).not.toBeNull();
        expect(cred!.name).toBe(MCP_GATEWAY_CREDENTIAL_NAME);
        expect(cred!.env_var_name).toBe(MCP_GATEWAY_DEFAULT_ENV_VAR);
        expect(cred!.enabled).toBe(1);
        // Tool names array must reference the catalog tool_key.
        const credToolNames = JSON.parse(cred!.tool_names ?? '[]') as string[];
        expect(credToolNames).toContain(MCP_GATEWAY_TOOL_KEY);

        // Second call must not create duplicates and must reuse the same IDs.
        const second = await registerMCPGatewayInCatalog(db);
        expect(second.catalogId).toBe(first.catalogId);
        expect(second.credentialId).toBe(first.credentialId);

        const allCreds = await db.listToolCredentials();
        expect(allCreds.filter((c) => c.name === MCP_GATEWAY_CREDENTIAL_NAME).length).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // ── Phase 4 — DB-driven gateway exposure config ──────────────────────────
    it('preserves operator-edited enabled toggle and exposed_classes on re-register', async () => {
      const { dir, dbPath } = makeTempDbPath();
      const db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
      try {
        // Initial registration writes defaults.
        const first = await registerMCPGatewayInCatalog(db);

        // Operator disables the gateway and narrows the exposed classes.
        await db.updateToolConfig(first.catalogId, {
          enabled: 0,
          config: JSON.stringify({
            endpoint: '/api/mcp/gateway',
            server_name: 'geneweave-gateway',
            auth_scheme: 'Bearer',
            // Operator decided only `web` and `search` should be reachable.
            exposed_classes: ['web', 'search'],
            exposed_tool_keys: ['web_search'],
          }),
        });

        // Re-register (simulating next boot) must NOT clobber operator edits.
        await registerMCPGatewayInCatalog(db);
        const after = await db.getToolCatalogByKey(MCP_GATEWAY_TOOL_KEY);
        expect(after).not.toBeNull();
        expect(after!.enabled).toBe(0); // preserved
        const cfg = JSON.parse(after!.config ?? '{}') as {
          exposed_classes: string[];
          exposed_tool_keys: string[];
        };
        expect(cfg.exposed_classes).toEqual(['search', 'web']); // sorted, preserved
        // exposed_tool_keys is recomputed against the operator's class set,
        // so utility / cse / enterprise tools must not leak in.
        expect(cfg.exposed_tool_keys).toContain('web_search');
        expect(cfg.exposed_tool_keys).not.toContain('calculator');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('loadGatewayConfigFromCatalog returns operator-edited classes', async () => {
      const { dir, dbPath } = makeTempDbPath();
      const db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
      try {
        const reg = await registerMCPGatewayInCatalog(db);
        await db.updateToolConfig(reg.catalogId, {
          enabled: 1,
          config: JSON.stringify({
            endpoint: '/api/mcp/gateway',
            exposed_classes: ['web', 'social'],
            exposed_tool_keys: [],
          }),
        });
        const loaded = await loadGatewayConfigFromCatalog(db);
        expect(loaded.enabled).toBe(true);
        expect([...loaded.exposedClasses].sort()).toEqual(['social', 'web']);
        expect(loaded.endpoint).toBe('/api/mcp/gateway');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('loadGatewayConfigFromCatalog reports enabled=false when operator disabled', async () => {
      const { dir, dbPath } = makeTempDbPath();
      const db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
      try {
        const reg = await registerMCPGatewayInCatalog(db);
        await db.updateToolConfig(reg.catalogId, { enabled: 0 });
        const loaded = await loadGatewayConfigFromCatalog(db);
        expect(loaded.enabled).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('loadGatewayConfigFromCatalog falls back to defaults when catalog row absent', async () => {
      const { dir, dbPath } = makeTempDbPath();
      const db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });
      try {
        const loaded = await loadGatewayConfigFromCatalog(db);
        expect(loaded.enabled).toBe(true);
        expect([...loaded.exposedClasses].sort()).toEqual(
          [...DEFAULT_EXPOSED_ALLOCATION_CLASSES].sort(),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── Phase 3 — policy enforcement + audit on gateway invocations ─────────────
  describe('policy enforcement + audit emission', () => {
    /**
     * Boots the gateway with a stub web_search tool, an in-memory policy
     * resolver (default permissive), and a capturing audit emitter so we
     * can assert that traffic flowing through `/api/mcp/gateway` lands in
     * the same audit pipeline as in-process chat tool calls.
     */
    function makeStubTool(record: { invoked: number }): Tool {
      return {
        schema: {
          name: 'web_search',
          description: 'stub web_search for gateway policy test',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
          tags: ['web-search', 'search'],
          riskLevel: 'read-only',
        },
        async invoke() {
          record.invoked += 1;
          return { content: 'stub-ok' };
        },
      };
    }

    function startEnforcedGateway(token: string): Promise<{
      url: string;
      events: ToolAuditEvent[];
      stubCalls: { invoked: number };
      close: () => Promise<void>;
    }> {
      const stubCalls = { invoked: 0 };
      const stub = makeStubTool(stubCalls);
      const events: ToolAuditEvent[] = [];
      const auditEmitter: ToolAuditEmitter = { emit: async (e) => { events.push(e); } };
      const policyResolver = new InMemoryToolPolicyResolver();
      const gateway = createMCPGateway({
        token,
        tools: { web_search: stub },
        policyResolver,
        auditEmitter,
      });
      const server = createServer((req, res) => {
        void gateway.handle(req, res).catch(() => {
          if (!res.headersSent) { res.writeHead(500); res.end('error'); }
        });
      });
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as AddressInfo;
          resolve({
            url: `http://127.0.0.1:${addr.port}`,
            events,
            stubCalls,
            close: () =>
              new Promise<void>((r, rej) => {
                void gateway.close().then(() => server.close((err) => (err ? rej(err) : r())));
              }),
          });
        });
      });
    }

    it('emits a success audit event tagged with mcp-gateway chatId on tools/call', async () => {
      const TOKEN = 'phase3-test-token';
      const handle = await startEnforcedGateway(TOKEN);
      try {
        const r = await postJson(
          `${handle.url}/api/mcp/gateway`,
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'web_search', arguments: { q: 'hello' } },
          },
          { Authorization: `Bearer ${TOKEN}` },
        );
        expect(r.status).toBe(200);
        expect(handle.stubCalls.invoked).toBe(1);

        // Audit event must have been emitted exactly once with the synthetic
        // gateway chatId so operators can filter MCP traffic in the admin UI.
        expect(handle.events.length).toBe(1);
        const evt = handle.events[0]!;
        expect(evt.toolName).toBe('web_search');
        expect(evt.outcome).toBe('success');
        expect(evt.chatId).toBe('mcp-gateway');
        expect(evt.agentPersona).toBe('mcp-gateway');
      } finally {
        await handle.close();
      }
    });
  });
});
