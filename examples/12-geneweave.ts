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
 *
 * WeaveIntel packages used:
 *   @weaveintel/geneweave — The full-stack reference application that wires together:
 *     • @weaveintel/provider-openai & provider-anthropic — LLM adapters (auto-discovered)
 *     • @weaveintel/core       — ExecutionContext, EventBus, ToolRegistry, Model interface
 *     • @weaveintel/agents     — ReAct agent loop (used in Agent Mode chat)
 *     • @weaveintel/memory     — Conversation history per chat session
 *     • @weaveintel/redaction  — PII masking (if enabled in settings)
 *     • @weaveintel/evals      — Post-response quality evaluation
 *     • @weaveintel/observability — Trace recording for the Traces admin tab
 *
 *   createGeneWeave() is the single entry point. It:
 *     1. Initializes a SQLite database (users, sessions, chats, metrics, settings, etc.)
 *     2. Creates a ChatEngine that dynamically imports provider packages
 *     3. Seeds default admin data (default admin user, default settings)
 *     4. Spins up an HTTP server with auth, chat, dashboard, and admin API routes
 *     5. Serves a single-page app (SPA) with chat UI, dashboard charts, and admin panel
 */

import { createGeneWeave } from '@weaveintel/geneweave';

async function main() {
  const port = Number(process.env['PORT'] ?? '3500');

  // createGeneWeave() accepts a config object and returns a GeneWeaveApp handle.
  // The config wires together:
  //   • port/host     — HTTP server binding
  //   • jwtSecret     — Used by auth.ts (signJWT/verifyJWT) for session cookies
  //   • database      — SQLite path (auto-creates tables on first boot)
  //   • providers     — API keys keyed by provider name; ChatEngine dynamically
  //                      imports @weaveintel/provider-openai or provider-anthropic
  //   • defaultModel  — The model used when the user hasn't picked one yet
  const app = await createGeneWeave({
    port,
    // In production, use a strong secret (e.g. from env: process.env.JWT_SECRET)
    jwtSecret: 'change-me-in-production-' + Math.random().toString(36).slice(2),
    // SQLite database file — stores users, sessions, chats, messages, metrics,
    // evals, traces, settings, and model pricing data
    database: { type: 'sqlite', path: './geneweave.db' },
    // provider keys — only providers with valid API keys are registered;
    // ChatEngine.getAvailableModels() returns models from all active providers
    providers: {
      ...(process.env['ANTHROPIC_API_KEY'] ? { anthropic: { apiKey: process.env['ANTHROPIC_API_KEY'] } } : {}),
      ...(process.env['OPENAI_API_KEY'] ? { openai: { apiKey: process.env['OPENAI_API_KEY'] } } : {}),
    },
    defaultProvider: process.env['ANTHROPIC_API_KEY'] ? 'anthropic' : 'openai',
    defaultModel: process.env['ANTHROPIC_API_KEY'] ? 'claude-sonnet-4-20250514' : 'gpt-4o-mini',
  });

  // app.chatEngine.getAvailableModels() queries each registered provider
  // for its model catalog and returns a combined list.
  console.log(`  Models available: ${(await app.chatEngine.getAvailableModels()).map(m => m.provider + '/' + m.id).join(', ')}`);
  console.log(`  URL: http://localhost:${port}`);
  console.log('  Press Ctrl+C to stop\n');

  // Graceful shutdown: app.stop() closes the HTTP server and the SQLite database
  process.on('SIGINT', async () => {
    await app.stop();
    process.exit(0);
  });
}

main().catch(console.error);
