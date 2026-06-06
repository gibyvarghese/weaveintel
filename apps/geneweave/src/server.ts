/**
 * @weaveintel/geneweave — HTTP server + routes
 *
 * Zero-dependency HTTP server built on node:http with a hand-rolled router,
 * JSON body parsing, cookie handling, CORS, auth middleware, and SSE support.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { newUUIDv7 } from '@weaveintel/core';
import { readFile as fsReadFile } from 'node:fs/promises';
import { join, dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseAdapter } from './db.js';
import type { ChatEngine } from './chat.js';
import { DashboardService } from './dashboard.js';
import { getHTML } from './ui-server.js';
import { getDocsHTML } from './docs-html.js';
import { authenticateRequest, verifyCSRF } from './auth.js';
import { type TriggerDispatcherHandle } from './admin/api/triggers.js';
import { type LoadedGatewayConfig } from './mcp-gateway.js';
import { type OAuthProviderName } from '@weaveintel/oauth';
import {
  Router,
  json,
  html,
  SERVER_REQUEST_TIMEOUT_MS,
  SERVER_HEADERS_TIMEOUT_MS,
  SERVER_KEEP_ALIVE_TIMEOUT_MS,
  SERVER_MAX_HEADERS_COUNT,
  SERVER_MAX_REQUESTS_PER_SOCKET,
} from './server-core.js';
import {
  registerAuthRoutes,
  registerModelRoutes,
  registerSettingsRoutes,
  registerTraceRoutes,
  registerChatRoutes,
  registerAdminWiringRoutes,
} from './routes/index.js';

export interface ServerConfig {
  db: DatabaseAdapter;
  chatEngine: ChatEngine;
  jwtSecret: string;
  corsOrigin?: string;
  providers?: Record<string, { apiKey?: string }>;
  publicBaseUrl?: string;
  /**
   * Phase 4: snapshot of the gateway's exposure config loaded from the
   * `tool_catalog` row at startup. When omitted, code-level defaults are
   * used (for tests or embedded callers that have not seeded the catalog).
   */
  gatewayConfig?: LoadedGatewayConfig;
  /** App-wide runtime — threaded into admin routes so weaveAudit writes to durable KV. */
  runtime?: import('@weaveintel/core').WeaveRuntime;
  /**
   * Workflow Platform Phase 1: optional handle to the singleton
   * `DefaultWorkflowEngine` constructed at startup. When supplied, the
   * `POST /api/admin/workflows/:id/run` route uses it to start runs
   * against `workflow_defs`. When omitted (e.g. test boot) that route
   * returns 503 to make the missing wiring obvious.
   */
  workflowEngine?: import('./workflow-engine.js').WorkflowEngineHandle;
  /**
   * Phase 3 Unified Triggers: optional handle to the singleton
   * `TriggerDispatcher` plus its in-process `ManualSourceAdapter`.
   * When omitted, the trigger admin routes still serve CRUD against
   * `triggers`/`trigger_invocations` but the manual-fire route returns
   * 503 because there is no live dispatcher to route through.
   */
  triggerDispatcher?: TriggerDispatcherHandle;
}

export function createGeneWeaveServer(config: ServerConfig): Server {
  const { db, chatEngine, jwtSecret, corsOrigin, providers, publicBaseUrl, gatewayConfig, workflowEngine, triggerDispatcher } = config;
  const dashboard = new DashboardService(db);
  const router = new Router();
  const uiHtml = getHTML();
  const docsHtml = getDocsHTML();

  async function setOAuthState(state: string, value: { userId: string | null; provider: OAuthProviderName; expiresAt: number }): Promise<void> {
    await db.createOAuthFlowState({
      id: newUUIDv7(),
      state_key: state,
      user_id: value.userId,
      provider: value.provider,
      expires_at: new Date(value.expiresAt).toISOString(),
    });
  }

  async function consumeOAuthState(state: string): Promise<{ userId: string | null; provider: OAuthProviderName; expiresAt: number } | null> {
    const found = await db.consumeOAuthFlowStateByKey(state);
    if (!found) return null;
    return {
      userId: found.user_id,
      provider: found.provider as OAuthProviderName,
      expiresAt: Date.parse(found.expires_at),
    };
  }

  const oauthStateCleanupTimer = setInterval(() => {
    void db.deleteExpiredOAuthFlowStates().catch(() => {
      // Best effort cleanup only.
    });
  }, 60_000);
  oauthStateCleanupTimer.unref?.();

  // ── Route registration ─────────────────────────────────────

  registerAuthRoutes(router, db, { jwtSecret, corsOrigin, publicBaseUrl, setOAuthState, consumeOAuthState });
  registerModelRoutes(router, db, chatEngine, providers);
  registerSettingsRoutes(router, db);
  registerTraceRoutes(router, db, dashboard);
  registerChatRoutes(router, db, chatEngine, dashboard, workflowEngine as { getStatus?: () => unknown } | undefined);
  registerAdminWiringRoutes(router, db, { providers, publicBaseUrl, gatewayConfig, workflowEngine, triggerDispatcher, chatEngine, runtime: config.runtime });

  // ── Avatar static files ────────────────────────────────────

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const avatarDirs = [
    join(__dirname, '..', 'avatar'),
    join(__dirname, '..', 'avatars'),
    join(process.cwd(), 'packages', 'geneweave', 'avatar'),
    join(process.cwd(), 'packages', 'geneweave', 'avatars'),
    join(process.cwd(), 'avatar'),
    join(process.cwd(), 'avatars'),
  ];
  const distDir = join(__dirname, '..', 'dist');
  const distDirResolved = resolve(distDir);
  const staticModuleExtensions = new Set(['.js', '.css', '.map']);

  // ── HTTP server ────────────────────────────────────────────

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS
    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    // Serve UI module files (but NOT admin-schema.js - it's embedded in HTML)
    if ((method === 'GET' || method === 'HEAD') && pathname.match(/^\/(?:ui(?:\/|\.)|features\/)/)) {
      // Map /ui.js to /ui-client.js (client-side only module)
      let filename = pathname.slice(1);
      if (filename === 'ui.js') {
        filename = 'ui-client.js';
      }

      let decodedFilename = filename;
      try {
        decodedFilename = decodeURIComponent(filename);
      } catch {
        json(res, 404, { error: 'Not found' });
        return;
      }

      const hasInvalidSegment = decodedFilename
        .split('/')
        .some((segment) => segment === '..' || segment.includes('\0'));
      if (hasInvalidSegment) {
        json(res, 404, { error: 'Not found' });
        return;
      }

      const filepath = resolve(distDirResolved, decodedFilename);
      if (!filepath.startsWith(distDirResolved + sep)) {
        json(res, 404, { error: 'Not found' });
        return;
      }

      const extension = extname(filepath);
      if (!staticModuleExtensions.has(extension)) {
        json(res, 404, { error: 'Not found' });
        return;
      }

      try {
        const data = await fsReadFile(filepath);
        const contentType = extension === '.js'
          ? 'application/javascript'
          : extension === '.css'
            ? 'text/css'
            : 'application/json';
        res.writeHead(200, {
          'Content-Type': contentType + '; charset=utf-8',
          'Content-Length': data.length,
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        });
        if (method === 'GET') {
          res.end(data);
        } else {
          res.end(); // HEAD request: don't send body
        }
        return;
      } catch (err) {
        json(res, 404, { error: 'Not found' });
        return;
      }
    }

    // ── MCP Gateway pass-through ──
    // The gateway has its own bearer-token auth and the MCP SDK transport
    // reads the body itself, so we bypass the router (which would consume
    // the stream and apply CSRF). The gateway returns 503 when no token is
    // configured, so it is loud-fail rather than silent.
    const mcpGatewayHandle = (router as unknown as { _mcpGateway?: { handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> } })._mcpGateway;
    if (pathname === '/api/mcp/gateway' && (method === 'POST' || method === 'GET' || method === 'DELETE')) {
      if (mcpGatewayHandle) {
        try {
          await mcpGatewayHandle.handle(req, res);
        } catch (err) {
          console.error('[geneWeave][mcp-gateway] handler error:', err);
          if (!res.headersSent) {
            json(res, 500, { error: 'MCP gateway error' });
          }
        }
      } else {
        json(res, 503, { error: 'MCP gateway not configured' });
      }
      return;
    }

    // API routing
    const matched = router.match(method, pathname);
    if (matched) {
      try {
        // Authenticate
        const auth = await authenticateRequest(req, db, jwtSecret);
        // Check auth requirement
        if (matched.route.requireAuth && !auth) {
          json(res, 401, { error: 'Authentication required' });
          return;
        }

        // Check CSRF for mutating requests
        if (matched.route.requireCSRF && auth && !verifyCSRF(req, auth)) {
          json(res, 403, { error: 'Invalid CSRF token' });
          return;
        }

        await matched.route.handler(req, res, matched.params, auth);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Internal server error';
        const correlationId = newUUIDv7();
        console.error(`[geneWeave][${correlationId}] Error handling ${method} ${pathname}:`, err);
        if (!res.headersSent) {
          if (msg === 'Request body too large') {
            json(res, 413, { error: 'Request body too large' });
          } else if (msg === 'Too many concurrent request bodies') {
            json(res, 503, { error: 'Server is busy reading other requests. Please retry shortly.' });
          } else {
            json(res, 500, { error: 'Internal server error', correlationId });
          }
        }
      }
      return;
    }

    // Serve avatar images
    const avatarMatch = pathname.match(/^\/avatar\/(avatar-\d+\.webp)$/);
    if (method === 'GET' && avatarMatch) {
      const filename = avatarMatch[1]!;
      let data: Buffer | null = null;
      for (const dir of avatarDirs) {
        try {
          data = await fsReadFile(join(dir, filename));
          break;
        } catch {
          // Try next candidate directory.
        }
      }
      if (data) {
        res.writeHead(200, {
          'Content-Type': 'image/webp',
          'Content-Length': data.length,
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        res.end(data);
      } else {
        json(res, 404, { error: 'Avatar not found' });
      }
      return;
    }

    // Developer documentation — served from apps/geneweave/docs/weaveintel-docs.html
    // when present (operator-authored), with a fall-back to the generated docsHtml.
    if (method === 'GET' && (pathname === '/docs' || pathname === '/docs/')) {
      const staticDocsPath = join(__dirname, '..', 'docs', 'weaveintel-docs.html');
      try {
        const body = await fsReadFile(staticDocsPath, 'utf8');
        html(res, 200, body);
      } catch {
        html(res, 200, docsHtml);
      }
      return;
    }

    // Serve UI for all non-API routes (SPA)
    if (method === 'GET') {
      html(res, 200, uiHtml);
      return;
    }

    json(res, 404, { error: 'Not found' });
  });

  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = SERVER_MAX_HEADERS_COUNT;
  server.maxRequestsPerSocket = SERVER_MAX_REQUESTS_PER_SOCKET;

  return server;
}
