/**
 * Example 131 — Evaluator-optimizer agent (W2)
 *
 * Demonstrates the verify→regenerate loop: after a terminal response, a
 * `Verifier` checks the output quality. If it fails, the loop regenerates.
 *
 * Key concepts:
 *   • `Verifier` — interface with `verify(ctx, output, context): VerifyResult`
 *   • `verify.verifier`    — the verifier implementation
 *   • `verify.maxAttempts` — max regeneration attempts before accepting as-is
 *   • W1 (reflect) and W2 (verify) compose: verify runs first, reflect after
 *
 * No API key needed — uses createMockModel from @weaveintel/devtools.
 *
 * Run: npx tsx examples/131-evaluator-optimizer.ts
 */

import { weaveAgent } from '@weaveintel/agents';
import { weaveContext } from '@weaveintel/core';
import type { Verifier, VerifyResult, ExecutionContext } from '@weaveintel/core';
import { createMockModel } from '@weaveintel/devtools';

// A custom verifier that checks whether the output mentions a specific keyword.
function createKeywordVerifier(keyword: string): Verifier {
  return {
    async verify(_ctx: ExecutionContext, output: string): Promise<VerifyResult> {
      const passed = output.toLowerCase().includes(keyword.toLowerCase());
      return {
        passed,
        reason: passed
          ? `Output contains required keyword "${keyword}"`
          : `Output must mention "${keyword}" — please regenerate with more detail.`,
      };
    },
  };
}

async function main() {
  // Mock returns: first a bad answer (no keyword), then a good answer
  const model = createMockModel({
    name: 'mock-verify',
    responses: [
      'I recommend using Python.',   // fails verification (no "type hints")
      'I recommend using Python with type hints for better maintainability.',  // passes
    ],
  });

  const agent = weaveAgent({
    model,
    maxSteps: 8,
    name: 'verify-demo',
    verify: {
      verifier: createKeywordVerifier('type hints'),
      maxAttempts: 2,
    },
  });

  const ctx = weaveContext({});
  const result = await agent.run(ctx, {
    messages: [{ role: 'user', content: 'What language should I use for a new backend project?' }],
  });

  console.log('Status   :', result.status);
  console.log('Output   :', result.output);
  console.log('Steps    :', result.steps.length);

  const verifySteps = result.steps.filter((s) => s.content?.startsWith('[verify:'));
  if (verifySteps.length) {
    console.log('\nVerification steps:');
    verifySteps.forEach((s) => console.log(' •', s.content));
  }
}

main().catch(console.error);
