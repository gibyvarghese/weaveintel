/**
 * Default `/api/me/runs` run-agent (SP3).
 *
 * Bridges the run executor to the platform agent loop: it resolves the
 * configured default model, runs `weaveAgent.runStream`, and translates the
 * agent's step events onto the executor's `MeRunEmitter` (text deltas,
 * tool invoked/completed). The executor owns run lifecycle + sequencing; this
 * function only produces domain output and honours `args.signal` cooperatively.
 *
 * Kept deliberately thin and free of the chat-specific pipeline (memory,
 * skills, guardrail judges) so it stays reusable across surfaces. Richer
 * per-surface behaviour can be layered by supplying a different `MeRunAgent`.
 */

import { weaveAgent } from '@weaveintel/agents';
import type { Message } from '@weaveintel/core';
import type { ChatEngineConfig } from './chat-runtime.js';
import { getOrCreateModel } from './chat-runtime.js';
import type { MeRunAgent } from './me-run-executor.js';

const DEFAULT_SYSTEM_PROMPT =
  'You are weaveIntel, a helpful, concise assistant. Answer the user clearly and directly.';

/** Pull the user prompt text out of the run start payload. */
function extractPrompt(input: Record<string, unknown>): string {
  const candidates = [input['text'], input['prompt'], input['content'], input['message']];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c;
  }
  return '';
}

export function createDefaultMeRunAgent(config: ChatEngineConfig): MeRunAgent {
  return async (args, emit) => {
    const prompt = extractPrompt(args.input);
    if (!prompt) {
      await emit.text('No input was provided for this run.');
      return;
    }

    const provider = config.defaultProvider;
    const modelId = config.defaultModel;
    const providerCfg = config.providers[provider] ?? {};
    const model = await getOrCreateModel(provider, modelId, providerCfg);

    const agent = weaveAgent({
      model,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    });

    const messages: Message[] = [{ role: 'user', content: prompt }];

    // Prefer streaming; fall back to a single generate when unavailable.
    if (agent.runStream) {
      for await (const ev of agent.runStream(args.ctx, { messages, goal: prompt })) {
        if (args.signal.aborted) return;
        switch (ev.type) {
          case 'text_chunk': {
            if (ev.text) await emit.text(ev.text);
            break;
          }
          case 'tool_start': {
            const tc = ev.step?.toolCall;
            if (tc?.name) await emit.toolInvoked(tc.name, tc.arguments);
            break;
          }
          case 'tool_end': {
            const tc = ev.step?.toolCall;
            if (tc?.name) await emit.toolCompleted(tc.name, tc.result);
            break;
          }
          default:
            break;
        }
      }
      return;
    }

    const result = await agent.run(args.ctx, { messages, goal: prompt });
    if (args.signal.aborted) return;
    if (result.output) await emit.text(result.output);
  };
}
