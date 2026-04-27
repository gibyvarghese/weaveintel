/**
 * @weaveintel/geneweave — Public API
 *
 * The single entry-point for consumers. Install the package, call
 * `createGeneWeave(config)`, and you have a running chat + dashboard server.
 *
 * @example
 * ```ts
 * import { createGeneWeave } from '@weaveintel/geneweave';
 *
 * const app = await createGeneWeave({
 *   port: 3000,
 *   jwtSecret: process.env.JWT_SECRET!,
 *   database: { type: 'sqlite', path: './geneweave.db' },
 *   providers: {
 *     anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
 *   },
 *   defaultModel: 'claude-sonnet-4-20250514',
 *   defaultProvider: 'anthropic',
 * });
 *
 * console.log(`geneWeave running → http://localhost:${app.port}`);
 * ```
 */

import type { Server } from 'node:http';
import { weaveSetDefaultTracer } from '@weaveintel/core';
import { weaveConsoleTracer } from '@weaveintel/observability';
import { createDatabaseAdapter, type DatabaseAdapter, type DatabaseConfig } from './db.js';
import { ChatEngine, type ProviderConfig } from './chat.js';
import { createGeneWeaveServer } from './server.js';
import { syncModelPricing, type PricingSyncReport } from './pricing-sync.js';
import { syncToolCatalog } from './tools.js';
import { startToolHealthJob } from './tool-health-job.js';
import { registerMCPGatewayInCatalog } from './mcp-gateway.js';
import { seedSVData } from './features/scientific-validation/sv-seed.js';

export type { PricingSyncReport };

// ─── Config ──────────────────────────────────────────────────

export interface GeneWeaveConfig {
  /** Port to listen on (default: 3500) */
  port?: number;
  /** Host to bind (default: '0.0.0.0') */
  host?: string;
  /** Secret for signing JWT tokens — MUST be a strong random string in production */
  jwtSecret: string;
  /** Database config — defaults to SQLite at ./geneweave.db */
  database?: DatabaseConfig;
  /** Provider API keys keyed by provider name */
  providers: Record<string, ProviderConfig>;
  /** Default provider key (must match a key in providers) */
  defaultProvider: string;
  /** Default model ID to use */
  defaultModel: string;
  /** CORS origin — set to your frontend URL in production */
  corsOrigin?: string;
  /** Absolute public origin used for OAuth callbacks when behind a proxy */
  publicBaseUrl?: string;
}

// ─── App handle ──────────────────────────────────────────────

export interface GeneWeaveApp {
  /** The port the server is listening on */
  port: number;
  /** Underlying Node.js HTTP server */
  server: Server;
  /** Database adapter (for advanced use / testing) */
  db: DatabaseAdapter;
  /** Chat engine (for programmatic use) */
  chatEngine: ChatEngine;
  /** Sync model pricing from provider APIs into the database */
  syncPricing(): Promise<PricingSyncReport>;
  /** Gracefully stop the server and close the database */
  stop(): Promise<void>;
}

// ─── Factory ─────────────────────────────────────────────────

/**
 * createGeneWeave() is the single entry-point for the entire application.
 * It wires together all WeaveIntel subsystems in order:
 *
 *  1. Database — SQLite adapter for persistence (users, sessions, chats, metrics)
 *  2. ChatEngine — orchestrates @weaveintel/models, @weaveintel/agents,
 *     @weaveintel/observability, @weaveintel/redaction, @weaveintel/evals,
 *     @weaveintel/guardrails, @weaveintel/routing, and @weaveintel/cache
 *  3. seedDefaultData — creates admin user and default settings on first run
 *  4. HTTP Server — zero-dependency router with auth, CORS, SSE streaming
 *  5. Returns a GeneWeaveApp handle with stop() for graceful shutdown
 */
export async function createGeneWeave(config: GeneWeaveConfig): Promise<GeneWeaveApp> {
  // Ensure cross-package runtime tracing is enabled by default for all execution paths.
  weaveSetDefaultTracer(weaveConsoleTracer());

  const activeProviders = Object.fromEntries(
    Object.entries(config.providers).filter(([, provider]) => Boolean(provider?.apiKey?.trim())),
  );
  if (Object.keys(activeProviders).length === 0) {
    throw new Error('At least one provider with a non-empty apiKey is required.');
  }
  if (!activeProviders[config.defaultProvider]) {
    throw new Error(`Default provider "${config.defaultProvider}" is not configured with an apiKey.`);
  }

  const port = config.port ?? 3500;
  const host = config.host ?? '0.0.0.0';

  // 1. Database
  const db = await createDatabaseAdapter(config.database ?? { type: 'sqlite', path: './geneweave.db' });

  // 2. Chat engine
  const chatEngine = new ChatEngine(
    {
      providers: activeProviders,
      defaultProvider: config.defaultProvider,
      defaultModel: config.defaultModel,
    },
    db,
  );

  // 3. Seed default admin data (no-op if already seeded)
  await db.seedDefaultData();

  // 3a. Seed Scientific Validation prompts and worker agents
  await seedSVData(db);

  // 4. Sync BUILTIN_TOOLS into tool_catalog so operators can manage them
  await syncToolCatalog(db);

  // 4a. Self-register the internal MCP gateway in tool_catalog + tool_credentials
  // so operators discover it through the admin UI. Idempotent on every boot.
  await registerMCPGatewayInCatalog(db);

  // 5. Start background tool health snapshot job (writes every 15 min)
  startToolHealthJob(db);

  // 5. HTTP server
  const server = createGeneWeaveServer({
    db,
    chatEngine,
    jwtSecret: config.jwtSecret,
    corsOrigin: config.corsOrigin,
    providers: activeProviders,
    publicBaseUrl: config.publicBaseUrl,
  });

  // 5. Listen
  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      console.log(`\n  🧬 geneWeave running → http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\n`);
      resolve();
    });
  });

  return {
    port,
    server,
    db,
    chatEngine,
    async syncPricing() {
      return syncModelPricing(db, activeProviders);
    },
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await db.close();
      console.log('  🧬 geneWeave stopped');
    },
  };
}

// ─── Re-exports for advanced usage ───────────────────────────

export type { DatabaseAdapter, DatabaseConfig, UserRow, SessionRow, ChatRow, MessageRow, MetricRow, EvalRow, MetricsSummary, ChatSettingsRow, TraceRow, PromptRow, GuardrailRow, RoutingPolicyRow, WorkflowDefRow, ToolConfigRow, ToolCatalogRow, WorkflowRunRow, GuardrailEvalRow, ToolPolicyRow, ToolRateLimitBucketRow, ToolAuditEventRow, ToolHealthSnapshotRow, ToolCredentialRow } from './db.js';
export { SQLiteAdapter, createDatabaseAdapter } from './db.js';
export type { ProviderConfig, ChatEngineConfig, ChatSettings } from './chat.js';
export { ChatEngine, calculateCost } from './chat.js';
export { DashboardService } from './dashboard.js';
export type { AuthContext, JWTPayload } from './auth.js';
export { signJWT, verifyJWT, hashPassword, verifyPassword, generateCSRFToken } from './auth.js';
export { BUILTIN_TOOLS, createToolRegistry, getAvailableTools } from './tools.js';
