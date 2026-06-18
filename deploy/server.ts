/**
 * Production entrypoint for geneWeave.
 *
 * Environment variables:
 *   PORT              – HTTP port (default: 3500)
 *   JWT_SECRET        – Required. Secret for signing auth tokens.
 *   DATABASE_PATH     – SQLite file path (default: ./data/geneweave.db)
 *                       Ignored when DATABASE_URL is set.
 *   DATABASE_URL      – Postgres connection string (postgres://user:pass@host/db).
 *                       When set, geneWeave expects a custom DatabaseAdapter to be
 *                       injected via the adapter property in the database config.
 *                       SQLite is used as a fallback when this is unset.
 *                       Production deployments should always set DATABASE_URL so that
 *                       state is durable across restarts and shared across replicas.
 *   ANTHROPIC_API_KEY – Anthropic API key (optional)
 *   OPENAI_API_KEY    – OpenAI API key (optional)
 *   GEMINI_API_KEY    – Google Gemini API key (optional; GOOGLE_API_KEY also accepted)
 *   OLLAMA_BASE_URL   – Ollama server URL (optional, default http://localhost:11434)
 *   LLAMACPP_BASE_URL – llama.cpp server URL (optional, default http://localhost:8080)
 *   DEFAULT_PROVIDER  – "anthropic" | "openai" | "google" | "ollama" | "llamacpp" (auto-detected if omitted)
 *   DEFAULT_MODEL     – Model ID (auto-detected if omitted)
 *   CORS_ORIGIN       – Allowed CORS origin (optional)
 */

import { createGeneWeave, createLogger } from '../apps/geneweave/src/index.ts';
import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const log = createLogger('geneweave-deploy');
// Resolve root .env explicitly so the server finds it regardless of CWD
const __serverDir = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__serverDir, '../.env') });

async function main() {
  const port = parseInt(process.env['PORT'] ?? '3500', 10);
  const jwtSecret = process.env['JWT_SECRET'];
  if (!jwtSecret) {
    log.error('JWT_SECRET environment variable is required — set it before starting the server');
    process.exit(1);
  }

  const hasAnthropic = !!process.env['ANTHROPIC_API_KEY'];
  const hasOpenAI = !!process.env['OPENAI_API_KEY'];
  const googleKey = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'] ?? process.env['GOOGLE_GENERATIVE_AI_API_KEY'];
  const hasGoogle = !!googleKey;
  const hasOllama = !!process.env['OLLAMA_BASE_URL'] || process.env['ENABLE_OLLAMA'] === '1';
  const hasLlamaCpp = !!process.env['LLAMACPP_BASE_URL'] || process.env['ENABLE_LLAMACPP'] === '1';
  const useMockProvider = process.env['PLAYWRIGHT_E2E'] === '1' && !hasAnthropic && !hasOpenAI && !hasGoogle && !hasOllama && !hasLlamaCpp;

  if (!hasAnthropic && !hasOpenAI && !hasGoogle && !hasOllama && !hasLlamaCpp && !useMockProvider) {
    log.error('At least one provider must be configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OLLAMA_BASE_URL, or LLAMACPP_BASE_URL');
    process.exit(1);
  }

  const providers: Record<string, { apiKey?: string; baseUrl?: string; mockResponses?: string[]; latencyMs?: number }> = {};
  if (hasAnthropic) providers['anthropic'] = { apiKey: process.env['ANTHROPIC_API_KEY']! };
  if (hasOpenAI) providers['openai'] = { apiKey: process.env['OPENAI_API_KEY']! };
  if (hasGoogle) providers['google'] = { apiKey: googleKey! };
  if (hasOllama) providers['ollama'] = { baseUrl: process.env['OLLAMA_BASE_URL'], apiKey: process.env['OLLAMA_API_KEY'] };
  if (hasLlamaCpp) providers['llamacpp'] = { baseUrl: process.env['LLAMACPP_BASE_URL'], apiKey: process.env['LLAMACPP_API_KEY'] };
  if (useMockProvider) {
    providers['mock'] = {
      apiKey: '__mock__',
      latencyMs: 25,
      mockResponses: [
        'Revenue peaks in Apr with the strongest profit margin, Mar is the weakest month, and the Jan to Apr jump is the main anomaly worth investigating.',
      ],
    };
  }

  const defaultProvider = process.env['DEFAULT_PROVIDER']
    ?? (useMockProvider
      ? 'mock'
      : hasAnthropic
        ? 'anthropic'
        : hasOpenAI
          ? 'openai'
          : hasGoogle
            ? 'google'
            : hasOllama
              ? 'ollama'
              : 'llamacpp');
  const defaultModel = process.env['DEFAULT_MODEL']
    ?? (defaultProvider === 'anthropic'
      ? 'claude-sonnet-4-20250514'
      : defaultProvider === 'mock'
        ? 'mock-model'
        : defaultProvider === 'google'
          ? 'gemini-2.5-flash'
          : defaultProvider === 'ollama'
            ? 'llama3.1'
            : defaultProvider === 'llamacpp'
              ? 'local'
              : 'gpt-4o-mini');

  // Database — prefer DATABASE_URL (Postgres) when set; fall back to SQLite for
  // local/development use. In production always set DATABASE_URL so state is shared
  // across replicas and survives container restarts.
  const databaseUrl = process.env['DATABASE_URL'];
  const sqliteOverride = process.env['GENEWEAVE_SQLITE_OVERRIDE'] === '1';

  if (databaseUrl) {
    // Validate the URL scheme so operators get a clear error rather than a
    // cryptic driver failure when they mistype the connection string.
    if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
      log.error('DATABASE_URL must be a Postgres connection string (postgres:// or postgresql://)');
      process.exit(1);
    }
    if (!sqliteOverride) {
      // A Postgres adapter is not bundled in the open-source release.
      // Operators must inject a custom DatabaseAdapter and call createGeneWeave
      // directly, or set GENEWEAVE_SQLITE_OVERRIDE=1 to allow SQLite fallback
      // in local dev environments that have DATABASE_URL in their env.
      // See: docs/postgres-adapter.md for the integration guide.
      log.error('DATABASE_URL is set but no Postgres adapter is bundled — provide a custom adapter via createGeneWeave({ database: { type: "custom", adapter: yourAdapter } }) or set GENEWEAVE_SQLITE_OVERRIDE=1 for local dev');
      process.exit(1);
    }
    log.warn('DATABASE_URL is set but GENEWEAVE_SQLITE_OVERRIDE=1 — starting with SQLite (dev/test only)');
  }

  const app = await createGeneWeave({
    port,
    jwtSecret,
    database: { type: 'sqlite', path: process.env['DATABASE_PATH'] ?? './data/geneweave.db' },
    providers,
    defaultProvider,
    defaultModel,
    corsOrigin: process.env['CORS_ORIGIN'],
  });

  const models = await app.chatEngine.getAvailableModels();
  log.info('server ready', { models: models.map(m => `${m.provider}/${m.id}`).join(', '), port });

  const shutdown = async (signal: string) => {
    log.info(`${signal} received — shutting down...`);
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason, promise) => {
    log.error('Unhandled promise rejection', { reason, promise: String(promise) });
    // Log and continue — do not crash on transient unhandled rejections (e.g.
    // a cancelled request or a network hiccup in a background poller).
    // If the process is in an unrecoverable state the next health check will
    // catch it and the orchestrator (systemd / k8s) will restart cleanly.
  });

  process.on('uncaughtException', (err, origin) => {
    log.error('Uncaught exception', { err, origin });
    // An uncaughtException means execution state is undefined — flush logs and
    // exit so the process supervisor can restart with a clean slate.
    process.exit(1);
  });
}

main().catch((err) => {
  log.error('Fatal startup error', { err });
  process.exit(1);
});
