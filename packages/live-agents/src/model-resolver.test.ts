/**
 * Phase 1 — `ModelResolver` unit tests + integration with
 * `createAgenticTaskHandler` (validation paths only — the full ReAct loop
 * has its own end-to-end coverage).
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  ExecutionContext,
  Model,
  ModelRequest,
  ModelResponse,
} from '@weaveintel/core';
import {
  composeModelResolvers,
  resolveModelForTick,
  weaveModelResolver,
  weaveModelResolverFromFn,
  type ModelResolver,
} from './model-resolver.js';
import { createAgenticTaskHandler } from './agentic-task-handler.js';

function fakeModel(id: string): Model {
  return {
    info: {
      provider: 'fake',
      modelId: id,
      capabilities: new Set(),
    },
    capabilities: new Set(),
    hasCapability: () => false,
    async generate(
      _ctx: ExecutionContext,
      _request: ModelRequest,
    ): Promise<ModelResponse> {
      return {
        id: 'res-1',
        model: id,
        content: `from ${id}`,
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  } as unknown as Model;
}

describe('weaveModelResolver', () => {
  it('returns the pinned model for any context', async () => {
    const m = fakeModel('pinned');
    const r = weaveModelResolver({ model: m });
    expect(await r.resolve({})).toBe(m);
    expect(await r.resolve({ role: 'whatever' })).toBe(m);
  });

  it('throws when constructed without a model', () => {
    expect(() =>
      weaveModelResolver({ model: undefined as unknown as Model }),
    ).toThrow(/required/);
  });
});

describe('weaveModelResolverFromFn', () => {
  it('forwards context to the callback and returns its result', async () => {
    const m = fakeModel('cb');
    const fn = vi.fn(async () => m);
    const r = weaveModelResolverFromFn(fn);
    const out = await r.resolve({ role: 'strategist', agentId: 'a-1' });
    expect(out).toBe(m);
    expect(fn).toHaveBeenCalledWith({ role: 'strategist', agentId: 'a-1' });
  });

  it('rejects non-function input', () => {
    expect(() =>
      weaveModelResolverFromFn(undefined as unknown as () => undefined),
    ).toThrow(/function/);
  });
});

describe('composeModelResolvers', () => {
  it('returns first non-undefined resolver result', async () => {
    const a: ModelResolver = { resolve: () => undefined };
    const m = fakeModel('b');
    const b: ModelResolver = { resolve: () => m };
    const c: ModelResolver = { resolve: () => fakeModel('c-should-not-run') };
    const r = composeModelResolvers([a, b, c]);
    expect(await r.resolve({})).toBe(m);
  });

  it('treats throws as undefined and continues the chain', async () => {
    const log = vi.fn();
    const a: ModelResolver = {
      resolve: () => {
        throw new Error('boom');
      },
    };
    const m = fakeModel('b');
    const b: ModelResolver = { resolve: () => m };
    const r = composeModelResolvers([a, b], { log });
    expect(await r.resolve({})).toBe(m);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]![0]).toMatch(/boom/);
  });

  it('rejects empty arrays', () => {
    expect(() => composeModelResolvers([])).toThrow(/non-empty/);
  });
});

describe('resolveModelForTick fallback chain', () => {
  it('uses resolver result when present (source=resolver)', async () => {
    const resolver = weaveModelResolver({ model: fakeModel('resolved') });
    const pinned = fakeModel('pinned');
    const out = await resolveModelForTick(resolver, pinned, {});
    expect(out.source).toBe('resolver');
    expect((out.model.info as { modelId: string }).modelId).toBe('resolved');
  });

  it('falls back to pinned model when resolver returns undefined', async () => {
    const resolver: ModelResolver = { resolve: () => undefined };
    const pinned = fakeModel('pinned');
    const out = await resolveModelForTick(resolver, pinned, {});
    expect(out.source).toBe('pinned');
    expect(out.model).toBe(pinned);
    expect(out.error).toBeUndefined();
  });

  it('falls back to pinned model when resolver throws and captures error', async () => {
    const resolver: ModelResolver = {
      resolve: () => {
        throw new Error('rate-limited');
      },
    };
    const pinned = fakeModel('pinned');
    const out = await resolveModelForTick(resolver, pinned, {});
    expect(out.source).toBe('pinned');
    expect(out.error).toMatch(/rate-limited/);
  });

  it('uses pinned model when no resolver provided', async () => {
    const pinned = fakeModel('pinned');
    const out = await resolveModelForTick(undefined, pinned, {});
    expect(out.source).toBe('pinned');
  });

  it('throws clearly when neither resolver nor pinned is available', async () => {
    await expect(
      resolveModelForTick(undefined, undefined, {}),
    ).rejects.toThrow(/no model available/);
  });

  it('throws and surfaces resolver error when resolver fails and pinned is absent', async () => {
    const resolver: ModelResolver = {
      resolve: () => {
        throw new Error('routing-down');
      },
    };
    await expect(resolveModelForTick(resolver, undefined, {})).rejects.toThrow(
      /routing-down/,
    );
  });
});

describe('createAgenticTaskHandler — Phase 1 wiring', () => {
  const stubPrepare = async () => ({
    systemPrompt: 'sys',
    userGoal: 'goal',
  });

  it('throws at construction when neither model nor modelResolver is given', () => {
    expect(() =>
      createAgenticTaskHandler({
        name: 'test',
        prepare: stubPrepare,
      }),
    ).toThrow(/`model`.*`modelResolver`/);
  });

  it('accepts a pinned model only (parity with weaveAgent)', () => {
    expect(() =>
      createAgenticTaskHandler({
        name: 'test',
        model: fakeModel('pin'),
        prepare: stubPrepare,
      }),
    ).not.toThrow();
  });

  it('accepts a modelResolver only (live-agents extension)', () => {
    expect(() =>
      createAgenticTaskHandler({
        name: 'test',
        modelResolver: weaveModelResolver({ model: fakeModel('r') }),
        prepare: stubPrepare,
      }),
    ).not.toThrow();
  });

  it('accepts both — resolver wins per tick, pinned is fallback', () => {
    expect(() =>
      createAgenticTaskHandler({
        name: 'test',
        model: fakeModel('pin'),
        modelResolver: weaveModelResolver({ model: fakeModel('r') }),
        prepare: stubPrepare,
      }),
    ).not.toThrow();
  });
});
