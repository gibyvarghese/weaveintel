import { describe, it, expect, vi } from 'vitest';
import { a2aInboundHandler } from './a2a-inbound.js';
import type { HandlerContext } from '../handler-registry.js';

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    binding: { id: 'b1', agentId: 'a1', handlerKind: 'a2a.inbound', config: {} },
    agent: { id: 'a1', meshId: 'm1', roleKey: 'processor', name: 'Processor' },
    log: () => {},
    model: {
      id: 'mock',
      info: { modelId: 'mock', provider: 'mock' },
      call: vi.fn().mockResolvedValue({ text: 'processed' }),
    } as unknown as HandlerContext['model'],
    ...overrides,
  };
}

describe('a2a.inbound handler', () => {
  it('has the correct kind', () => {
    expect(a2aInboundHandler.kind).toBe('a2a.inbound');
  });

  it('factory throws when neither model nor modelResolver is provided', () => {
    const ctx = makeCtx({ model: undefined, modelResolver: undefined });
    expect(() => a2aInboundHandler.factory(ctx)).toThrow('HandlerContext.model OR HandlerContext.modelResolver');
  });

  it('factory returns a TaskHandler function when model is provided', () => {
    const ctx = makeCtx();
    const handler = a2aInboundHandler.factory(ctx);
    expect(typeof handler).toBe('function');
  });

  it('factory returns a TaskHandler function when modelResolver is provided', () => {
    const ctx = makeCtx({
      model: undefined,
      modelResolver: { resolve: vi.fn().mockResolvedValue(undefined) } as unknown as HandlerContext['modelResolver'],
    });
    const handler = a2aInboundHandler.factory(ctx);
    expect(typeof handler).toBe('function');
  });

  it('reads maxSteps from config', () => {
    const ctx = makeCtx({ binding: { id: 'b1', agentId: 'a1', handlerKind: 'a2a.inbound', config: { maxSteps: 10 } } });
    const handler = a2aInboundHandler.factory(ctx);
    expect(typeof handler).toBe('function');
  });

  it('has a configSchema', () => {
    expect(a2aInboundHandler.configSchema).toBeTruthy();
    expect(a2aInboundHandler.configSchema?.['type']).toBe('object');
  });

  it('description mentions A2A', () => {
    expect(a2aInboundHandler.description).toMatch(/A2A/i);
  });
});
