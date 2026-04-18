/**
 * Production entrypoint for geneWeave.
 *
 * Environment variables:
 *   PORT              – HTTP port (default: 3500)
 *   JWT_SECRET        – Required. Secret for signing auth tokens.
 *   DATABASE_PATH     – SQLite file path (default: ./data/geneweave.db)
 *   ANTHROPIC_API_KEY – Anthropic API key (optional)
 *   OPENAI_API_KEY    – OpenAI API key (optional)
 *   DEFAULT_PROVIDER  – "anthropic" | "openai" (auto-detected if omitted)
 *   DEFAULT_MODEL     – Model ID (auto-detected if omitted)
 *   CORS_ORIGIN       – Allowed CORS origin (optional)
 */

import { createGeneWeave } from '../apps/geneweave/src/index.ts';
import 'dotenv/config';

async function main() {
  const port = parseInt(process.env['PORT'] ?? '3500', 10);
  const jwtSecret = process.env['JWT_SECRET'];
  if (!jwtSecret) {
    console.error('ERROR: JWT_SECRET environment variable is required');
    process.exit(1);
  }

  const hasAnthropic = !!process.env['ANTHROPIC_API_KEY'];
  const hasOpenAI = !!process.env['OPENAI_API_KEY'];

  if (!hasAnthropic && !hasOpenAI) {
    console.error('ERROR: At least one of ANTHROPIC_API_KEY or OPENAI_API_KEY is required');
    process.exit(1);
  }

  const providers: Record<string, { apiKey: string }> = {};
  if (hasAnthropic) providers['anthropic'] = { apiKey: process.env['ANTHROPIC_API_KEY']! };
  if (hasOpenAI) providers['openai'] = { apiKey: process.env['OPENAI_API_KEY']! };

  const defaultProvider = process.env['DEFAULT_PROVIDER']
    ?? (hasAnthropic ? 'anthropic' : 'openai');
  const defaultModel = process.env['DEFAULT_MODEL']
    ?? (defaultProvider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o-mini');

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
