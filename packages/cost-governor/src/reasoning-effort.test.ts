/**
 * Phase 7 — Reasoning Effort wrapper unit tests.
 */
import { describe, expect, it } from 'vitest';
import type {
  ExecutionContext,
  Model,
  ModelInfo,
  ModelRequest,
  ModelResponse,
} from '@weaveintel/core';
import {
  wrapModelWithReasoningEffort,
  wrapModelWithStaticReasoningEffort,
} from './reasoning-effort.js';

function makeInner(capture: { req?: ModelRequest }, withStream = false): Model {
  const info: ModelInfo = {
    provider: 'openai',
    modelId: 'm-1',
    capabilities: new Set(),
  };
  const base: Model = {
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
  if (!withStream) return base;
  return {
    ...base,
    stream(_ctx: ExecutionContext, req: ModelRequest) {
      capture.req = req;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'delta' as const, delta: 'ok' };
        },
      } as never;
    },
  };
}

const ctx: ExecutionContext = { executionId: 'r-1', metadata: {} };
const minimalReq = (): ModelRequest => ({ messages: [{ role: 'user', content: 'hi' }] });

describe('wrapModelWithReasoningEffort', () => {
  it('stamps metadata.reasoningEffort on every call', async () => {
    const cap: { req?: ModelRequest } = {};
    const wrapped = wrapModelWithReasoningEffort(makeInner(cap), {
      resolveEffort: () => 'high',
    });
    await wrapped.generate(ctx, minimalReq());
    expect(cap.req?.metadata).toEqual({ reasoningEffort: 'high' });
  });

  it('forwards request unchanged when resolver returns null/undefined', async () => {
    const cap: { req?: ModelRequest } = {};
    const wrapped = wrapModelWithReasoningEffort(makeInner(cap), {
      resolveEffort: () => null,
    });
    await wrapped.generate(ctx, minimalReq());
    expect(cap.req?.metadata).toBeUndefined();
  });

  it('forwards unchanged when resolver throws (graceful)', async () => {
    const cap: { req?: ModelRequest } = {};
    const wrapped = wrapModelWithReasoningEffort(makeInner(cap), {
      resolveEffort: () => {
        throw new Error('boom');
      },
    });
    await wrapped.generate(ctx, minimalReq());
    expect(cap.req?.metadata).toBeUndefined();
  });

  it('preserves existing metadata fields', async () => {
    const cap: { req?: ModelRequest } = {};
    const wrapped = wrapModelWithReasoningEffort(makeInner(cap), {
      resolveEffort: () => 'low',
    });
    await wrapped.generate(ctx, { ...minimalReq(), metadata: { other: 'keep' } });
    expect(cap.req?.metadata).toEqual({ other: 'keep', reasoningEffort: 'low' });
  });

  it('omits stream when inner has none (conditional spread)', () => {
    const cap: { req?: ModelRequest } = {};
    const wrapped = wrapModelWithReasoningEffort(makeInner(cap, false), {
      resolveEffort: () => 'medium',
    });
    expect(wrapped.stream).toBeUndefined();
  });

  it('forwards stream when inner has one', async () => {
    const cap: { req?: ModelRequest } = {};
    const wrapped = wrapModelWithReasoningEffort(makeInner(cap, true), {
      resolveEffort: () => 'medium',
    });
    expect(typeof wrapped.stream).toBe('function');
  });

  it('inherits inner.info and capabilities verbatim', () => {
    const inner = makeInner({});
    const wrapped = wrapModelWithReasoningEffort(inner, { resolveEffort: () => 'high' });
    expect(wrapped.info).toBe(inner.info);
    expect(wrapped.capabilities).toBe(inner.capabilities);
  });
});

describe('wrapModelWithStaticReasoningEffort', () => {
  it('stamps the fixed effort on every call', async () => {
    const cap: { req?: ModelRequest } = {};
    const wrapped = wrapModelWithStaticReasoningEffort(makeInner(cap), 'medium');
    await wrapped.generate(ctx, minimalReq());
    await wrapped.generate(ctx, minimalReq());
    expect(cap.req?.metadata?.['reasoningEffort']).toBe('medium');
  });
});
