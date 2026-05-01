// Quick smoke test: make sure Claude can run a tiny ReAct loop with one Kaggle tool.
import 'dotenv/config';
import { weaveAgent } from '@weaveintel/agents';
import { weaveContext, weaveToolRegistry, weaveTool } from '@weaveintel/core';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
  const model = weaveAnthropicModel(process.env.KAGGLE_PLANNER_MODEL || 'claude-sonnet-4-5', { apiKey });

  const reg = weaveToolRegistry();
  reg.register(
    weaveTool({
      name: 'echo',
      description: 'Echo back the message argument verbatim. Use this once then stop.',
      parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      tags: ['test'],
      riskLevel: 'read-only',
      execute: async (args) => `echoed: ${String(args['message'])}`,
    }),
  );

  const agent = weaveAgent({
    name: 'smoke',
    model,
    tools: reg,
    systemPrompt: 'You are a test. Call the echo tool once with message="hi" then reply with the tool result.',
    maxSteps: 4,
  });

  const ctx = weaveContext({ userId: 'smoke' });
  console.log('Calling Claude...');
  const t0 = Date.now();
  try {
    const res = await agent.run(ctx, { goal: 'smoke', messages: [{ role: 'user', content: 'go' }] });
    console.log(`Done in ${Date.now() - t0}ms, status=${res.status}, steps=${res.steps.length}`);
    for (const s of res.steps) {
      console.log(` - ${s.type}: ${(s.content ?? '').slice(0, 200)}`);
    }
  } catch (e) {
    console.error(`Threw after ${Date.now() - t0}ms:`, e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
