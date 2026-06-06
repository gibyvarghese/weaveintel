/**
 * Example 137 — Streaming output halt (W5)
 *
 * Uses weaveFakeModel streaming + createStreamingGuardrail to halt a stream
 * mid-generation when a blocked phrase appears. Shows that a clean stream
 * completes unchanged and a blocked stream stops early.
 *
 * Run: npx tsx examples/137-streaming-halt.ts
 */
import type { Guardrail } from '@weaveintel/core';
import { weaveContext, weaveRuntime } from '@weaveintel/core';
import { weaveFakeModel } from '@weaveintel/testing';
import { createStreamingGuardrail } from '@weaveintel/guardrails';

const SAFETY_BLOCKLIST: Guardrail = {
  id: 'stream-safety',
  name: 'Stream safety blocklist',
  type: 'blocklist',
  stage: 'post-execution',
  enabled: true,
  config: { words: ['classified', 'top secret'], action: 'deny' },
};

async function streamWithGuard(label: string, modelResponse: string): Promise<void> {
  const ctx = weaveContext({ runtime: weaveRuntime() });
  void ctx; // context available for audit if needed

  const model = weaveFakeModel({ responses: [modelResponse] });
  const guard = createStreamingGuardrail({
    guardrails: [SAFETY_BLOCKLIST],
    minBufferSize: 0, // check every chunk for demo clarity
  });

  console.log(`\n── ${label}`);
  console.log(`   Full model text: "${modelResponse}"`);
  console.log(`   Stream output:   "`);

  let halted = false;
  let charCount = 0;

  for await (const chunk of model.stream!(ctx, { messages: [{ role: 'user', content: 'test' }] })) {
    if (chunk.type !== 'text' || !chunk.text) continue;

    const { halt, reason } = guard.checkChunk(chunk.text);
    if (halt) {
      console.log(`[HALTED: ${reason}]`);
      halted = true;
      break;
    }

    process.stdout.write(chunk.text);
    charCount += chunk.text.length;
  }

  if (!halted) {
    // Flush remaining buffer
    const { halt, reason } = guard.flush();
    if (halt) {
      console.log(`[HALTED at flush: ${reason}]`);
      halted = true;
    }
  }

  console.log('"');
  console.log(`   Result: ${halted ? '✗ Stream halted' : '✓ Stream complete'} (${charCount} chars emitted)`);
}

async function main() {
  console.log('\n=== Example 137: Streaming Output Halt ===');
  console.log('Demonstrates mid-stream halt via createStreamingGuardrail.\n');

  await streamWithGuard(
    'Clean stream — completes fully',
    'TypeScript generics allow you to write reusable, type-safe code that works with multiple types.',
  );

  await streamWithGuard(
    'Stream containing blocked phrase — halted mid-generation',
    'Here is the report. The classified data shows that top secret operations are underway.',
  );

  await streamWithGuard(
    'Blocked phrase near the end — most content emitted before halt',
    'This is a long response about many topics including databases, APIs, and microservices. And now: classified.',
  );

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
