/**
 * Unit tests for reflect.ts — createSelfCritic, createRubricCritic
 */

import { describe, it, expect } from 'vitest';
import { createSelfCritic, createRubricCritic } from './reflect.js';
import { makeCtx, stubTextModel, stubAdapter } from './test-helpers.js';
import type { RubricCriterion } from '@weaveintel/testing/evals';

const CRITERIA: RubricCriterion[] = [
  { id: 'accuracy', description: 'Factually correct', weight: 0.6 },
  { id: 'clarity', description: 'Well written', weight: 0.4 },
];

// ── createSelfCritic ─────────────────────────────────────────────────────────

describe('createSelfCritic', () => {
  it('accepted path: rating >= 7 → accepted: true', async () => {
    const ctx = makeCtx();
    const model = stubTextModel(JSON.stringify({ rating: 8, accepted: true, feedback: '' }));
    const critic = createSelfCritic({ model });
    const result = await critic.critique(ctx, 'What is 2+2?', '2+2 is 4.');
    expect(result.accepted).toBe(true);
    expect(result.score).toBeCloseTo(0.8, 2);
    expect(result.feedback).toBeUndefined();
  });

  it('rejected path: rating < 7 → accepted: false with feedback', async () => {
    const ctx = makeCtx();
    const model = stubTextModel(JSON.stringify({ rating: 4, accepted: false, feedback: 'Too vague' }));
    const critic = createSelfCritic({ model });
    const result = await critic.critique(ctx, 'Explain quantum', 'It is physics.');
    expect(result.accepted).toBe(false);
    expect(result.feedback).toBe('Too vague');
    expect(result.score).toBeCloseTo(0.4, 2);
  });

  it('accepted=false from model overrides rating >= 7', async () => {
    const ctx = makeCtx();
    const model = stubTextModel(JSON.stringify({ rating: 9, accepted: false, feedback: 'Wrong tone' }));
    const critic = createSelfCritic({ model });
    const result = await critic.critique(ctx, 'hi', 'draft');
    expect(result.accepted).toBe(false);
    expect(result.feedback).toBe('Wrong tone');
  });

  it('non-JSON model response → rejected with raw content as feedback', async () => {
    const ctx = makeCtx();
    const model = stubTextModel('I cannot evaluate this.');
    const critic = createSelfCritic({ model });
    const result = await critic.critique(ctx, 'q', 'a');
    expect(result.accepted).toBe(false);
    expect(result.score).toBe(0);
    expect(result.feedback).toContain('I cannot evaluate');
  });

  it('JSON wrapped in markdown fences is parsed correctly', async () => {
    const ctx = makeCtx();
    const body = JSON.stringify({ rating: 8, accepted: true, feedback: '' });
    const model = stubTextModel('```json\n' + body + '\n```');
    const critic = createSelfCritic({ model });
    const result = await critic.critique(ctx, 'q', 'a');
    expect(result.accepted).toBe(true);
  });

  it('minScore override: rating 7/10 = 0.7, accepts at minScore=0.7', async () => {
    const ctx = makeCtx();
    const model = stubTextModel(JSON.stringify({ rating: 7, accepted: true, feedback: '' }));
    const critic = createSelfCritic({ model, minScore: 0.7 });
    const result = await critic.critique(ctx, 'q', 'a');
    expect(result.accepted).toBe(true);
  });

  it('minScore override: rating 7/10 = 0.7, rejects at minScore=0.8', async () => {
    const ctx = makeCtx();
    const model = stubTextModel(JSON.stringify({ rating: 7, accepted: true, feedback: '' }));
    const critic = createSelfCritic({ model, minScore: 0.8 });
    const result = await critic.critique(ctx, 'q', 'a');
    expect(result.accepted).toBe(false);
  });

  it('missing rating field defaults to 5 → score 0.5', async () => {
    const ctx = makeCtx();
    const model = stubTextModel(JSON.stringify({ accepted: true, feedback: '' }));
    const critic = createSelfCritic({ model });
    const result = await critic.critique(ctx, 'q', 'a');
    expect(result.score).toBeCloseTo(0.5, 2);
  });

  it('custom criteria string is forwarded to the model', async () => {
    const ctx = makeCtx();
    let seenPrompt = '';
    const caps = new Set(['chat' as never]);
    const model = {
      info: { provider: 'stub', modelId: 'spy', capabilities: caps },
      capabilities: caps,
      hasCapability: () => false,
      async generate(_ctx: unknown, req: { messages: Array<{ role: string; content: string }> }) {
        seenPrompt = req.messages[0]?.content ?? '';
        return { id: 'r', model: 'spy', content: JSON.stringify({ rating: 8, accepted: true, feedback: '' }), toolCalls: [], finishReason: 'stop' as const, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      },
    };
    const critic = createSelfCritic({ model: model as never, criteria: 'MUST_BE_HAIKU' });
    await critic.critique(ctx, 'q', 'a');
    expect(seenPrompt).toContain('MUST_BE_HAIKU');
  });
});

// ── createRubricCritic ───────────────────────────────────────────────────────

describe('createRubricCritic', () => {
  it('accepted path: score >= minScore', async () => {
    const ctx = makeCtx();
    const adapter = stubAdapter([{ score: 0.85, reason: 'well done' }]);
    const critic = createRubricCritic({ adapter, criteria: CRITERIA });
    const result = await critic.critique(ctx, 'q', 'great answer');
    expect(result.accepted).toBe(true);
    expect(result.score).toBeCloseTo(0.85, 2);
    expect(result.feedback).toBeUndefined();
  });

  it('rejected path: score < minScore', async () => {
    const ctx = makeCtx();
    const adapter = stubAdapter([{ score: 0.4, reason: 'too brief' }]);
    const critic = createRubricCritic({ adapter, criteria: CRITERIA });
    const result = await critic.critique(ctx, 'q', 'short answer');
    expect(result.accepted).toBe(false);
    expect(result.feedback).toBe('too brief');
  });

  it('rejected without adapter reason falls back to default message', async () => {
    const ctx = makeCtx();
    const adapter = stubAdapter([{ score: 0.3 }]);
    const critic = createRubricCritic({ adapter, criteria: CRITERIA, minScore: 0.6 });
    const result = await critic.critique(ctx, 'q', 'a');
    expect(result.accepted).toBe(false);
    expect(result.feedback).toContain('0.30');
  });

  it('score clamped: adapter returns 1.2 → clamped to 1.0', async () => {
    const ctx = makeCtx();
    const adapter = stubAdapter([{ score: 1.2 }]);
    const critic = createRubricCritic({ adapter, criteria: CRITERIA });
    const result = await critic.critique(ctx, 'q', 'a');
    expect(result.score).toBe(1);
    expect(result.accepted).toBe(true);
  });

  it('score clamped: adapter returns -0.5 → clamped to 0', async () => {
    const ctx = makeCtx();
    const adapter = stubAdapter([{ score: -0.5 }]);
    const critic = createRubricCritic({ adapter, criteria: CRITERIA });
    const result = await critic.critique(ctx, 'q', 'a');
    expect(result.score).toBe(0);
    expect(result.accepted).toBe(false);
  });

  it('minScore=0: always accepted', async () => {
    const ctx = makeCtx();
    const adapter = stubAdapter([{ score: 0 }]);
    const critic = createRubricCritic({ adapter, criteria: CRITERIA, minScore: 0 });
    const result = await critic.critique(ctx, 'q', 'a');
    expect(result.accepted).toBe(true);
  });

  it('minScore=1: only accepted at score exactly 1', async () => {
    const ctx = makeCtx();
    const adapter = stubAdapter([{ score: 0.99 }]);
    const critic = createRubricCritic({ adapter, criteria: CRITERIA, minScore: 1 });
    const result = await critic.critique(ctx, 'q', 'a');
    expect(result.accepted).toBe(false);
  });
});
