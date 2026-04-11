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
import { createDatabaseAdapter, type DatabaseAdapter, type DatabaseConfig } from './db.js';
import { ChatEngine, type ProviderConfig } from './chat.js';
import { createGeneWeaveServer } from './server.js';

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
  /** Gracefully stop the server and close the database */
  stop(): Promise<void>;
}

// ─── Factory ─────────────────────────────────────────────────

export async function createGeneWeave(config: GeneWeaveConfig): Promise<GeneWeaveApp> {
  const port = config.port ?? 3500;
  const host = config.host ?? '0.0.0.0';

  // 1. Database
  const db = await createDatabaseAdapter(config.database ?? { type: 'sqlite', path: './geneweave.db' });

  // 2. Chat engine
  const chatEngine = new ChatEngine(
    {
      providers: config.providers,
      defaultProvider: config.defaultProvider,
      defaultModel: config.defaultModel,
    },
    db,
  );

  // 3. Seed default admin data (no-op if already seeded)
  await db.seedDefaultData();

  // 4. HTTP server
  const server = createGeneWeaveServer({
    db,
    chatEngine,
    jwtSecret: config.jwtSecret,
    corsOrigin: config.corsOrigin,
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

export type { DatabaseAdapter, DatabaseConfig, UserRow, SessionRow, ChatRow, MessageRow, MetricRow, EvalRow, MetricsSummary, ChatSettingsRow, TraceRow, PromptRow, GuardrailRow, RoutingPolicyRow, WorkflowDefRow, ToolConfigRow, WorkflowRunRow, GuardrailEvalRow } from './db.js';
export { SQLiteAdapter, createDatabaseAdapter } from './db.js';
export type { ProviderConfig, ChatEngineConfig, ChatSettings } from './chat.js';
export { ChatEngine, calculateCost } from './chat.js';
export { DashboardService } from './dashboard.js';
export type { AuthContext, JWTPayload } from './auth.js';
export { signJWT, verifyJWT, hashPassword, verifyPassword, generateCSRFToken } from './auth.js';
export { BUILTIN_TOOLS, createToolRegistry, getAvailableTools } from './tools.js';
