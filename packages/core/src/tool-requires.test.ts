/**
 * Phase 2 — Capability-requirement enforcement on `defineTool`.
 *
 * Proves a tool declaring `requires: ['runtime.persistence']` is rejected
 * when the active runtime lacks persistence, and accepted when it doesn't.
 */
import { describe, it, expect } from 'vitest';
import { defineTool } from './tools.js';
import { weaveRuntime, RuntimeCapabilities, weaveInMemoryPersistence } from './runtime.js';
import { createExecutionContext as weaveContext } from './context.js';

describe('defineTool — capability requirements', () => {
  const persistTool = defineTool({
    name: 'persist_dlq',
    description: 'Writes a dead-letter envelope. Requires durable backend.',
    parameters: { type: 'object', properties: {} },
    requires: [RuntimeCapabilities.Persistence],
    async execute() { return 'ok'; },
  });

  it('schema preserves declared requires', () => {
    expect(persistTool.schema.requires).toEqual([RuntimeCapabilities.Persistence]);
  });

  it('rejects invocation when runtime is missing the capability', async () => {
    const rt = weaveRuntime({ installDefaultTracer: false }); // no persistence slot
    const ctx = weaveContext({ runtime: rt });
    await expect(persistTool.invoke(ctx, { name: 'persist_dlq', arguments: {} }))
      .rejects.toThrow(/missing required capability\(ies\): runtime\.persistence/);
  });

  it('accepts invocation when runtime advertises the capability', async () => {
    const rt = weaveRuntime({
      installDefaultTracer: false,
      persistence: weaveInMemoryPersistence(),
    });
    const ctx = weaveContext({ runtime: rt });
    const out = await persistTool.invoke(ctx, { name: 'persist_dlq', arguments: {} });
    expect(out.content).toBe('ok');
  });

  it('no-runtime context skips the check (zero-config DX preserved)', async () => {
    const ctx = weaveContext({});
    const out = await persistTool.invoke(ctx, { name: 'persist_dlq', arguments: {} });
    expect(out.content).toBe('ok');
  });

  it('tools without requires never assert', async () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    const ctx = weaveContext({ runtime: rt });
    const t = defineTool({
      name: 'pure', description: 'no requirements', parameters: { type: 'object' },
      async execute() { return 'pure-ok'; },
    });
    const out = await t.invoke(ctx, { name: 'pure', arguments: {} });
    expect(out.content).toBe('pure-ok');
  });
});

describe('createToolRegistry({ runtime }) — registration-time requires (Phase 3)', () => {
  it('throws at register() when runtime lacks the declared capability', async () => {
    const { weaveRuntime, RuntimeCapabilities } = await import('./runtime.js');
    const { createToolRegistry, defineTool } = await import('./tools.js');
    const rt = weaveRuntime({ installDefaultTracer: false });
    const reg = createToolRegistry({ runtime: rt });
    const tool = defineTool({
      name: 'needs_persistence',
      description: 'requires persistence slot which is not configured',
      parameters: { type: 'object', properties: {} },
      requires: [RuntimeCapabilities.Persistence],
      async execute() { return 'ok'; },
    });
    expect(() => reg.register(tool)).toThrow(/persistence/i);
  });

  it('register() succeeds when runtime satisfies the requirements', async () => {
    const { weaveRuntime, RuntimeCapabilities } = await import('./runtime.js');
    const { createToolRegistry, defineTool } = await import('./tools.js');
    const rt = weaveRuntime({ installDefaultTracer: false });
    const reg = createToolRegistry({ runtime: rt });
    const tool = defineTool({
      name: 'needs_egress',
      description: 'needs only baseline egress',
      parameters: { type: 'object', properties: {} },
      requires: [RuntimeCapabilities.NetEgress],
      async execute() { return 'ok'; },
    });
    expect(() => reg.register(tool)).not.toThrow();
    expect(reg.get('needs_egress')).toBeDefined();
  });

  it('register() ignores runtime check when no runtime supplied (back-compat)', async () => {
    const { RuntimeCapabilities } = await import('./runtime.js');
    const { createToolRegistry, defineTool } = await import('./tools.js');
    const reg = createToolRegistry();
    const tool = defineTool({
      name: 'unchecked',
      description: 'no registry runtime → no register-time check',
      parameters: { type: 'object', properties: {} },
      requires: [RuntimeCapabilities.Persistence],
      async execute() { return 'ok'; },
    });
    expect(() => reg.register(tool)).not.toThrow();
  });
});
