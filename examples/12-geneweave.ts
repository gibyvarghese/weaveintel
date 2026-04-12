/**
 * Example 12 — geneWeave: AI chatbot + observability dashboard
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-… npx tsx examples/12-geneweave.ts
 *
 * Then open http://localhost:3000 in your browser.
 *  - Register an account
 *  - Start chatting (supports streaming + multiple models)
 *  - Switch to the Dashboard tab to see token usage, costs, and latency
 */

import { createGeneWeave } from '@weaveintel/geneweave';

async function main() {
  const app = await createGeneWeave({
    port: 3500,
    jwtSecret: 'change-me-in-production-' + Math.random().toString(36).slice(2),
    database: { type: 'sqlite', path: './geneweave.db' },
    providers: {
      ...(process.env['ANTHROPIC_API_KEY'] ? { anthropic: { apiKey: process.env['ANTHROPIC_API_KEY'] } } : {}),
      ...(process.env['OPENAI_API_KEY'] ? { openai: { apiKey: process.env['OPENAI_API_KEY'] } } : {}),
    },
    defaultProvider: process.env['ANTHROPIC_API_KEY'] ? 'anthropic' : 'openai',
    defaultModel: process.env['ANTHROPIC_API_KEY'] ? 'claude-sonnet-4-20250514' : 'gpt-4o-mini',
  });

  console.log(`  Models available: ${(await app.chatEngine.getAvailableModels()).map(m => m.provider + '/' + m.id).join(', ')}`);
  console.log('  Press Ctrl+C to stop\n');

  process.on('SIGINT', async () => {
    await app.stop();
    process.exit(0);
  });
}

main().catch(console.error);
