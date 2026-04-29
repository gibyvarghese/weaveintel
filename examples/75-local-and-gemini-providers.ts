/**
 * Example 75 — Local + Cloud providers via Gemini, Ollama, and llama.cpp
 *
 * Demonstrates the three new provider packages:
 *   - @weaveintel/provider-google     → Google Gemini
 *   - @weaveintel/provider-ollama     → Local LLMs via Ollama (http://localhost:11434)
 *   - @weaveintel/provider-llamacpp   → Local GGUF via llama-server (http://localhost:8080)
 *
 * Each provider auto-registers on import. Pick whichever you have running.
 *
 * Run:
 *   GEMINI_API_KEY=...  npx tsx examples/75-local-and-gemini-providers.ts gemini
 *   OLLAMA_BASE_URL=http://localhost:11434  npx tsx examples/75-local-and-gemini-providers.ts ollama
 *   LLAMACPP_BASE_URL=http://localhost:8080  npx tsx examples/75-local-and-gemini-providers.ts llamacpp
 */

import type { Model, ExecutionContext } from '@weaveintel/core';
import { Capabilities } from '@weaveintel/core';
import { weaveGoogleModel } from '@weaveintel/provider-google';
import { weaveOllamaModel, weaveOllamaEmbeddingModel } from '@weaveintel/provider-ollama';
import { weaveLlamaCppModel } from '@weaveintel/provider-llamacpp';

const ctx: ExecutionContext = {
  executionId: 'example-75',
  tenantId: 'demo',
  userId: 'demo',
  metadata: {},
};

async function runChat(label: string, model: Model): Promise<void> {
  console.log(`\n— ${label} (${model.info.provider}/${model.info.modelId}) —`);

  // Non-streaming
  const res = await model.generate(ctx, {
    messages: [
      { role: 'system', content: 'You are concise. Answer in one sentence.' },
      { role: 'user', content: 'What is the capital of New Zealand?' },
    ],
    maxTokens: 64,
  });
  console.log('  generate:', res.content.trim());
  console.log('  usage:', res.usage);

  // Streaming
  if (!model.hasCapability(Capabilities.Streaming) || !model.stream) return;
  process.stdout.write('  stream:   ');
  const stream = model.stream(ctx, {
    messages: [{ role: 'user', content: 'Count from 1 to 5, comma-separated.' }],
    maxTokens: 32,
  });
  for await (const chunk of stream) {
    if (chunk.type === 'text' && chunk.text) process.stdout.write(chunk.text);
  }
  console.log();
}

async function main(): Promise<void> {
  const which = process.argv[2] ?? 'all';

  if (which === 'gemini' || which === 'all') {
    if (process.env['GEMINI_API_KEY'] || process.env['GOOGLE_API_KEY']) {
      await runChat('Gemini', weaveGoogleModel('gemini-2.5-flash'));
    } else {
      console.log('\n— Gemini — skipped (set GEMINI_API_KEY)');
    }
  }

  if (which === 'ollama' || which === 'all') {
    const baseUrl = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
    try {
      const r = await fetch(`${baseUrl}/api/tags`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const modelName = process.env['OLLAMA_MODEL'] ?? 'llama3.1';
      await runChat('Ollama', weaveOllamaModel(modelName));

      // Embeddings demo
      const emb = weaveOllamaEmbeddingModel(process.env['OLLAMA_EMBED_MODEL'] ?? 'nomic-embed-text');
      const embRes = await emb.embed(ctx, { input: ['hello world', 'goodbye'] });
      const dim = embRes.embeddings[0]?.length ?? 0;
      console.log(`  embed:    ${embRes.embeddings.length} vectors of dim ${dim}`);
    } catch (err) {
      console.log(`\n— Ollama — skipped (no server at ${baseUrl}: ${(err as Error).message})`);
    }
  }

  if (which === 'llamacpp' || which === 'all') {
    const baseUrl = process.env['LLAMACPP_BASE_URL'] ?? 'http://localhost:8080';
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await runChat('llama.cpp', weaveLlamaCppModel(process.env['LLAMACPP_MODEL'] ?? 'local'));
    } catch (err) {
      console.log(`\n— llama.cpp — skipped (no server at ${baseUrl}: ${(err as Error).message})`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
