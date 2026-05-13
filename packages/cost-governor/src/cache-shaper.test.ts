import { describe, expect, it } from 'vitest';
import type {
  ExecutionContext,
  Message,
  Model,
  ModelInfo,
  ModelRequest,
  ModelResponse,
} from '@weaveintel/core';
import {
  noopCacheShaper,
  weavePromptCachingShaper,
  wrapModelWithCacheHints,
  type CacheShapeContext,
} from './cache-shaper.js';

const baseCtx: CacheShapeContext = {
  provider: 'openai',
  role: 'strategist',
  phase: 'discovery',
  modelId: 'gpt-4o',
  version: '7',
};

describe('weavePromptCachingShaper', () => {
  it('returns null when disabled', () => {
    const s = weavePromptCachingShaper({ enabled: false });
    expect(s.compute(baseCtx)).toBeNull();
  });

  it('produces stable static keys', () => {
    const s = weavePromptCachingShaper({ enabled: true, keyStrategy: 'static' });
    const a = s.compute(baseCtx);
    const b = s.compute({ ...baseCtx, role: 'other', phase: 'kernel' });
    expect(a?.cacheKey).toBe('static:v7');
    expect(b?.cacheKey).toBe('static:v7');
  });

  it('defaults to role strategy', () => {
    const s = weavePromptCachingShaper({ enabled: true });
    const out = s.compute(baseCtx);
    expect(out?.cacheKey).toBe('role:strategist:v7');
    expect(out?.markSystemAsCacheable).toBe(true);
  });

  it('uses role+phase when configured', () => {
    const s = weavePromptCachingShaper({ enabled: true, keyStrategy: 'role+phase' });
    const out = s.compute(baseCtx);
    expect(out?.cacheKey).toBe('role:strategist:phase:discovery:v7');
  });

  it('falls back to defaults for missing fields', () => {
    const s = weavePromptCachingShaper({ enabled: true, keyStrategy: 'role+phase' });
    const out = s.compute({ provider: 'openai' });
    expect(out?.cacheKey).toBe('role:default:phase:default:v1');
  });

  it('sanitises cache key to ASCII ≤ 64', () => {
    const s = weavePromptCachingShaper({ enabled: true, keyStrategy: 'role' });
    const out = s.compute({ provider: 'openai', role: 'tëam!@#$ space', version: '\u00ff' });
    expect(out?.cacheKey).toMatch(/^[A-Za-z0-9_\-:.]+$/);
    expect(out!.cacheKey.length).toBeLessThanOrEqual(64);
  });
});

describe('noopCacheShaper', () => {
  it('always returns null', () => {
    expect(noopCacheShaper.compute(baseCtx)).toBeNull();
  });
});

// ── Wrapper tests ───────────────────────────────────────────

function makeInner(provider: string, capture: { req?: ModelRequest }): Model {
  const info: ModelInfo = {
    provider,
    modelId: 'm-1',
    capabilities: new Set(),
  };
  return {
    info,
    capabilities: info.capabilities,
    hasCapability: () => false,
    async generate(_ctx: ExecutionContext, req: ModelRequest): Promise<ModelResponse> {
      capture.req = req;
      return {
        id: 'r-1',
        content: 'ok',
        model: 'm-1',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: 'stop',
      };
    },
  };
}

const ctx: ExecutionContext = {
  executionId: 'run-1',
  metadata: {},
};

describe('wrapModelWithCacheHints (OpenAI mode)', () => {
  it('injects metadata.promptCacheKey when shaper produces a hint', async () => {
    const cap: { req?: ModelRequest } = {};
    const inner = makeInner('openai', cap);
    const shaper = weavePromptCachingShaper({ enabled: true, keyStrategy: 'role' });
    const wrapped = wrapModelWithCacheHints(inner, shaper, {
      resolveContext: () => ({ provider: 'openai', role: 'chat', version: '2' }),
    });
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ];
    await wrapped.generate(ctx, { messages });
    const md = cap.req?.metadata as Record<string, unknown> | undefined;
    expect(md?.['promptCacheKey']).toBe('role:chat:v2');
    // OpenAI mode does NOT touch messages.
    expect(cap.req?.messages).toHaveLength(2);
    expect(cap.req?.messages[0]?.role).toBe('system');
  });

  it('forwards request unchanged when shaper returns null', async () => {
    const cap: { req?: ModelRequest } = {};
    const inner = makeInner('openai', cap);
    const wrapped = wrapModelWithCacheHints(inner, noopCacheShaper, {
      resolveContext: () => ({ provider: 'openai' }),
    });
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    await wrapped.generate(ctx, { messages });
    expect(cap.req?.metadata).toBeUndefined();
    expect(cap.req?.messages).toHaveLength(1);
  });
});

describe('wrapModelWithCacheHints (Anthropic mode)', () => {
  it('rewrites system into content-block with cache_control and drops from messages', async () => {
    const cap: { req?: ModelRequest } = {};
    const inner = makeInner('anthropic', cap);
    const shaper = weavePromptCachingShaper({ enabled: true, keyStrategy: 'role' });
    const wrapped = wrapModelWithCacheHints(inner, shaper, {
      resolveContext: () => ({ provider: 'anthropic', role: 'critic', version: '3' }),
    });
    const messages: Message[] = [
      { role: 'system', content: 'long static prefix' },
      { role: 'user', content: 'go' },
    ];
    await wrapped.generate(ctx, { messages });
    const md = cap.req?.metadata as Record<string, unknown> | undefined;
    expect(md?.['promptCacheKey']).toBe('role:critic:v3');
    const sys = md?.['systemPrompt'] as Array<{ type: string; text: string; cache_control: { type: string; ttl?: string } }>;
    expect(Array.isArray(sys)).toBe(true);
    expect(sys[0]?.text).toBe('long static prefix');
    expect(sys[0]?.cache_control.type).toBe('ephemeral');
    // System message should be filtered out of messages array.
    expect(cap.req?.messages.find((m) => m.role === 'system')).toBeUndefined();
    expect(cap.req?.messages).toHaveLength(1);
  });

  it('leaves messages alone when no system message present', async () => {
    const cap: { req?: ModelRequest } = {};
    const inner = makeInner('anthropic', cap);
    const shaper = weavePromptCachingShaper({ enabled: true });
    const wrapped = wrapModelWithCacheHints(inner, shaper, {
      resolveContext: () => ({ provider: 'anthropic', role: 'x' }),
    });
    const messages: Message[] = [{ role: 'user', content: 'ping' }];
    await wrapped.generate(ctx, { messages });
    const md = cap.req?.metadata as Record<string, unknown> | undefined;
    expect(md?.['promptCacheKey']).toBeDefined();
    expect(md?.['systemPrompt']).toBeUndefined();
    expect(cap.req?.messages).toHaveLength(1);
  });
});

describe('wrapModelWithCacheHints — error tolerance', () => {
  it('forwards request unchanged when resolveContext returns null', async () => {
    const cap: { req?: ModelRequest } = {};
    const inner = makeInner('openai', cap);
    const shaper = weavePromptCachingShaper({ enabled: true });
    const wrapped = wrapModelWithCacheHints(inner, shaper, {
      resolveContext: () => null,
    });
    await wrapped.generate(ctx, { messages: [{ role: 'user', content: 'x' }] });
    expect(cap.req?.metadata).toBeUndefined();
  });

  it('swallows shaper.compute throws and forwards request unchanged', async () => {
    const cap: { req?: ModelRequest } = {};
    const inner = makeInner('openai', cap);
    const wrapped = wrapModelWithCacheHints(
      inner,
      {
        compute() {
          throw new Error('boom');
        },
      },
      { resolveContext: () => ({ provider: 'openai' }) },
    );
    await wrapped.generate(ctx, { messages: [{ role: 'user', content: 'x' }] });
    expect(cap.req?.metadata).toBeUndefined();
  });
});
