/**
 * Production entrypoint for geneWeave.
 *
 * Environment variables:
 *   PORT              – HTTP port (default: 3500)
 *   JWT_SECRET        – Required. Secret for signing auth tokens.
 *   DATABASE_PATH     – SQLite file path (default: ./data/geneweave.db)
 *   ANTHROPIC_API_KEY – Anthropic API key (optional)
 *   OPENAI_API_KEY    – OpenAI API key (optional)
 *   GEMINI_API_KEY    – Google Gemini API key (optional; GOOGLE_API_KEY also accepted)
 *   OLLAMA_BASE_URL   – Ollama server URL (optional, default http://localhost:11434)
 *   LLAMACPP_BASE_URL – llama.cpp server URL (optional, default http://localhost:8080)
 *   DEFAULT_PROVIDER  – "anthropic" | "openai" | "google" | "ollama" | "llamacpp" (auto-detected if omitted)
 *   DEFAULT_MODEL     – Model ID (auto-detected if omitted)
 *   CORS_ORIGIN       – Allowed CORS origin (optional)
 */

import { createGeneWeave } from '../apps/geneweave/src/index.ts';
import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Resolve root .env explicitly so the server finds it regardless of CWD
const __serverDir = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__serverDir, '../.env') });

async function main() {
  const port = parseInt(process.env['PORT'] ?? '3500', 10);
  const jwtSecret = process.env['JWT_SECRET'];
  if (!jwtSecret) {
    console.error('ERROR: JWT_SECRET environment variable is required');
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
    console.error('ERROR: At least one provider must be configured. Set one of:');
    console.error('  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OLLAMA_BASE_URL, or LLAMACPP_BASE_URL');
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
  console.log(`  Models: ${models.map(m => m.provider + '/' + m.id).join(', ')}`);
  console.log('  Ready.\n');

  const shutdown = async (signal: string) => {
    console.log(`\n  ${signal} received — shutting down...`);
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
