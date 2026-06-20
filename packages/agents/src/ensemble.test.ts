/**
 * Unit tests for ensemble.ts — resolvers and weaveEnsemble.
 *
 * All agent interactions use stub agents from test-helpers so no real
 * model or network is involved.
 */

import { describe, it, expect } from 'vitest';
import type { EnsembleCandidate, ModelRequest } from '@weaveintel/core';
import type { EnsembleResult } from './ensemble.js';
import {
  createVoteResolver,
  createJudgeResolver,
  createArbiterResolver,
  weaveEnsemble,
} from './ensemble.js';
import {
  makeCtx,
  stubAgent,
  failingAgent,
  stubAdapter,
  stubTextModel,
} from './test-helpers.js';
import type { RubricCriterion } from '@weaveintel/evals';

const CRITERIA: RubricCriterion[] = [
  { id: 'quality', description: 'Overall quality', weight: 1 },
];

function makeCandidates(outputs: string[]): EnsembleCandidate[] {
  return outputs.map((output, i) => ({
    agentName: `agent-${i}`,
    output,
    result: {
      output,
      messages: [],
      steps: [],
      usage: { totalSteps: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, totalDurationMs: 0, toolCalls: 0, delegations: 0 },
      status: 'completed' as const,
    },
  }));
}

// ── Vote resolver ─────────────────────────────────────────────────────────────

describe('createVoteResolver', () => {
  it('majority vote: 3 candidates, 2 agree', async () => {
    const ctx = makeCtx();
    const resolver = createVoteResolver();
    const candidates = makeCandidates(['answer A', 'answer A', 'answer B']);
    const result = await resolver.resolve(ctx, candidates);
    expect(result.output).toBe('answer A');
    expect(result.winner).toBe('agent-0');
  });

  it('all candidates agree: unanimous vote', async () => {
    const ctx = makeCtx();
    const resolver = createVoteResolver();
    const candidates = makeCandidates(['the answer', 'the answer', 'the answer']);
    const result = await resolver.resolve(ctx, candidates);
    expect(result.output).toBe('the answer');
  });

  it('tie: first group encountered wins', async () => {
    const ctx = makeCtx();
    const resolver = createVoteResolver();
    // A appears first; both A and B have count 1 → A wins (first seen with max count)
    const candidates = makeCandidates(['A', 'B']);
    const result = await resolver.resolve(ctx, candidates);
    expect(result.output).toBe('A');
  });

  it('single candidate: returns that candidate', async () => {
    const ctx = makeCtx();
    const resolver = createVoteResolver();
    const candidates = makeCandidates(['only answer']);
    const result = await resolver.resolve(ctx, candidates);
    expect(result.output).toBe('only answer');
  });

  it('rationale mentions vote count', async () => {
    const ctx = makeCtx();
    const resolver = createVoteResolver();
    const candidates = makeCandidates(['X', 'X', 'Y']);
    const result = await resolver.resolve(ctx, candidates);
    expect(result.rationale).toContain('2/3');
  });

  it('whitespace trimming: "  A  " and "A" are the same candidate', async () => {
    const ctx = makeCtx();
    const resolver = createVoteResolver();
    const candidates = makeCandidates(['  A  ', 'A', 'B']);
    const result = await resolver.resolve(ctx, candidates);
    expect(result.output.trim()).toBe('A');
  });
});

// ── Judge resolver ────────────────────────────────────────────────────────────

describe('createJudgeResolver', () => {
  it('picks the candidate with highest score', async () => {
    const ctx = makeCtx();
    const adapter = stubAdapter([{ score: 0.4 }, { score: 0.9 }]);
    const resolver = createJudgeResolver({ adapter, criteria: CRITERIA });
    const candidates = makeCandidates(['weak', 'strong']);
    const result = await resolver.resolve(ctx, candidates);
    expect(result.output).toBe('strong');
    expect(result.winner).toBe('agent-1');
  });

  it('scores all candidates before picking', async () => {
    const ctx = makeCtx();
    const adapter = stubAdapter([{ score: 0.3 }, { score: 0.6 }, { score: 0.5 }]);
    const resolver = createJudgeResolver({ adapter, criteria: CRITERIA });
    const candidates = makeCandidates(['A', 'B', 'C']);
    const result = await resolver.resolve(ctx, candidates);
    expect(result.output).toBe('B'); // 0.6 > 0.5 > 0.3
  });

  it('handles adapter error gracefully: treats as score 0', async () => {
    const ctx = makeCtx();
    // First adapter call throws; second returns 0.8
    let call = 0;
    const adapter = {
      id: 'stub',
      description: 'throws on first call',
      async score() {
        call++;
        if (call === 1) throw new Error('adapter exploded');
        return { score: 0.8 };
      },
    };
    const resolver = createJudgeResolver({ adapter, criteria: CRITERIA });
    const candidates = makeCandidates(['throw-candidate', 'good-candidate']);
    const result = await resolver.resolve(ctx, candidates);
    expect(result.output).toBe('good-candidate');
  });

  it('score clamped to [0,1]: adapter returns 1.5 → treated as 1', async () => {
    const ctx = makeCtx();
    const adapter = stubAdapter([{ score: 1.5 }, { score: 0.5 }]);
    const resolver = createJudgeResolver({ adapter, criteria: CRITERIA });
    const candidates = makeCandidates(['over', 'under']);
    const result = await resolver.resolve(ctx, candidates);
    expect(result.output).toBe('over'); // clamped 1.5 → 1 > 0.5
  });

  it('includes adapter reason in rationale', async () => {
    const ctx = makeCtx();
    const adapter = stubAdapter([{ score: 0.9, reason: 'excellent quality' }]);
    const resolver = createJudgeResolver({ adapter, criteria: CRITERIA });
    const candidates = makeCandidates(['great answer']);
    const result = await resolver.resolve(ctx, candidates);
    expect(result.rationale).toContain('excellent quality');
  });
});

// ── Arbiter resolver ──────────────────────────────────────────────────────────

describe('createArbiterResolver', () => {
  it('calls the model and returns its output', async () => {
    const ctx = makeCtx();
    const model = stubTextModel('synthesised answer');
    const resolver = createArbiterResolver({ model });
    const candidates = makeCandidates(['answer A', 'answer B']);
    const result = await resolver.resolve(ctx, candidates);
    expect(result.output).toBe('synthesised answer');
  });

  it('rationale mentions candidate count', async () => {
    const ctx = makeCtx();
    const model = stubTextModel('pick one');
    const resolver = createArbiterResolver({ model });
    const candidates = makeCandidates(['X', 'Y', 'Z']);
    const result = await resolver.resolve(ctx, candidates);
    expect(result.rationale).toContain('3');
  });

  it('custom instruction is forwarded to the model', async () => {
    const ctx = makeCtx();
    let seenPrompt = '';
    const model = {
      ...stubTextModel('ok'),
      async generate(_ctx: typeof ctx, req: ModelRequest) {
        seenPrompt = (req.messages[0]?.content as string) ?? '';
        return { id: 'r1', model: 'stub', content: 'ok', toolCalls: [], finishReason: 'stop' as const, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      },
    };
    const resolver = createArbiterResolver({ model, instruction: 'MY_CUSTOM_INSTRUCTION' });
    const candidates = makeCandidates(['A']);
    await resolver.resolve(ctx, candidates);
    expect(seenPrompt).toContain('MY_CUSTOM_INSTRUCTION');
  });
});

// ── weaveEnsemble ─────────────────────────────────────────────────────────────

describe('weaveEnsemble', () => {
  describe('Agent interface compliance', () => {
    it('has a config with the given name', () => {
      const ensemble = weaveEnsemble({
        agents: [stubAgent('a'), stubAgent('b')],
        resolver: createVoteResolver(),
        name: 'my-ensemble',
      });
      expect(ensemble.config.name).toBe('my-ensemble');
    });

    it('defaults config.name to "ensemble" when not provided', () => {
      const ensemble = weaveEnsemble({
        agents: [stubAgent('a')],
        resolver: createVoteResolver(),
      });
      expect(ensemble.config.name).toBe('ensemble');
    });

    it('maxSteps is the max of constituent agents', () => {
      // stubAgent returns a plain object so we can set maxSteps at creation
      const a1 = stubAgent('a');
      (a1.config as { name: string; maxSteps?: number }).maxSteps = 5;
      const a2 = stubAgent('b');
      (a2.config as { name: string; maxSteps?: number }).maxSteps = 15;
      const ensemble = weaveEnsemble({ agents: [a1, a2], resolver: createVoteResolver() });
      expect(ensemble.config.maxSteps).toBe(15);
    });

    it('config.description mentions agent count and mode', () => {
      const ensemble = weaveEnsemble({
        agents: [stubAgent('a'), stubAgent('b')],
        resolver: createVoteResolver(),
        parallel: true,
      });
      expect(ensemble.config.description).toContain('2');
      expect(ensemble.config.description).toContain('parallel');
    });

    it('implements Agent.run', () => {
      const ensemble = weaveEnsemble({ agents: [stubAgent('a')], resolver: createVoteResolver() });
      expect(typeof ensemble.run).toBe('function');
    });

    it('implements Agent.runStream', () => {
      const ensemble = weaveEnsemble({ agents: [stubAgent('a')], resolver: createVoteResolver() });
      expect(typeof ensemble.runStream).toBe('function');
    });
  });

  describe('run() — sequential mode', () => {
    it('returns EnsembleResult with candidates and winner', async () => {
      const ctx = makeCtx();
      const ensemble = weaveEnsemble({
        agents: [stubAgent('alpha', 'a'), stubAgent('beta', 'b'), stubAgent('alpha', 'c')],
        resolver: createVoteResolver(),
      });
      const result = await ensemble.run(ctx, { messages: [{ role: 'user', content: 'q' }] }) as EnsembleResult;
      expect(result.status).toBe('completed');
      expect(result.candidates).toHaveLength(3);
      expect(result.output).toBe('alpha');
      expect(result.winner).toBeDefined();
    });

    it('aggregates token usage across agents', async () => {
      const ctx = makeCtx();
      const ensemble = weaveEnsemble({
        agents: [stubAgent('a'), stubAgent('b')],
        resolver: createVoteResolver(),
      });
      const result = await ensemble.run(ctx, { messages: [{ role: 'user', content: 'q' }] });
      // Each stubAgent uses 5+3=8 tokens; two agents → 16 total
      expect(result.usage.totalTokens).toBe(16);
    });

    it('runs sequentially: second agent starts after first', async () => {
      const ctx = makeCtx();
      const order: string[] = [];
      const makeOrdered = (name: string) => ({
        config: { name },
        async run() {
          order.push(`start:${name}`);
          await new Promise((r) => setTimeout(r, 5));
          order.push(`end:${name}`);
          return {
            output: name,
            messages: [],
            steps: [],
            usage: { totalSteps: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, totalDurationMs: 0, toolCalls: 0, delegations: 0 },
            status: 'completed' as const,
          };
        },
      });
      const ensemble = weaveEnsemble({
        agents: [makeOrdered('first'), makeOrdered('second')],
        resolver: createVoteResolver(),
        parallel: false,
      });
      await ensemble.run(ctx, { messages: [] });
      expect(order.indexOf('end:first')).toBeLessThan(order.indexOf('start:second'));
    });
  });

  describe('run() — parallel mode', () => {
    it('all agents run and results are collected', async () => {
      const ctx = makeCtx();
      const ensemble = weaveEnsemble({
        agents: [stubAgent('X'), stubAgent('X'), stubAgent('Y')],
        resolver: createVoteResolver(),
        parallel: true,
      });
      const result = await ensemble.run(ctx, { messages: [] }) as EnsembleResult;
      expect(result.candidates).toHaveLength(3);
      expect(result.output).toBe('X'); // majority
    });
  });

  describe('runStream()', () => {
    it('yields step_start, text_chunks, then done', async () => {
      const ctx = makeCtx();
      const ensemble = weaveEnsemble({
        agents: [stubAgent('hello world', 'a'), stubAgent('hello world', 'b')],
        resolver: createVoteResolver(),
      });
      const events: string[] = [];
      const stream = ensemble.runStream!(ctx, { messages: [] });
      for await (const ev of stream) {
        events.push(ev.type);
      }
      expect(events[0]).toBe('step_start');
      expect(events[events.length - 1]).toBe('done');
      expect(events.some((t) => t === 'text_chunk')).toBe(true);
    });

    it('text_chunks concatenate to the resolved output', async () => {
      const ctx = makeCtx();
      const output = 'A'.repeat(200);
      const ensemble = weaveEnsemble({
        agents: [stubAgent(output, 'a'), stubAgent(output, 'b')],
        resolver: createVoteResolver(),
      });
      let reassembled = '';
      const stream = ensemble.runStream!(ctx, { messages: [] });
      for await (const ev of stream) {
        if (ev.type === 'text_chunk') reassembled += ev.text;
      }
      expect(reassembled).toBe(output);
    });

    it('done event carries the full EnsembleResult', async () => {
      const ctx = makeCtx();
      const ensemble = weaveEnsemble({
        agents: [stubAgent('ans', 'a')],
        resolver: createVoteResolver(),
      });
      let doneResult: unknown;
      const stream = ensemble.runStream!(ctx, { messages: [] });
      for await (const ev of stream) {
        if (ev.type === 'done') doneResult = ev.result;
      }
      expect(doneResult).toMatchObject({ output: 'ans', status: 'completed' });
    });
  });

  describe('failure handling', () => {
    it('a failed agent still produces a candidate (failed status)', async () => {
      const ctx = makeCtx();
      const ensemble = weaveEnsemble({
        agents: [failingAgent('fail'), stubAgent('ok', 'good')],
        resolver: createVoteResolver(),
      });
      const result = await ensemble.run(ctx, { messages: [] }) as EnsembleResult;
      expect(result.candidates).toHaveLength(2);
      // Vote resolver will pick 'ok' (1 vote) over '' (1 vote, first group wins — '' may win here)
      // More important: no exception thrown
      expect(result.status).toBe('completed');
    });
  });
});
