/**
 * Tests for `weaveDbModelResolver` and `weaveAgentOverlayResolver` (Phase 2).
 *
 * Uses fake routing/factory functions — no DB or external services. Verifies
 * the documented fallback contract: every failure mode returns `undefined`
 * so the live-agents runtime cleanly falls back to the pinned `model` slot.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Model } from '@weaveintel/core';
import {
  weaveDbModelResolver,
  type ModelCandidate,
} from './db-model-resolver.js';
import {
  weaveAgentOverlayResolver,
  type ModelResolvedAuditEvent,
} from './agent-overlay-resolver.js';
import type { AgentModelFieldsRowLike } from './model-resolver.js';

function fakeModel(label: string): Model {
  return { id: label, generate: vi.fn(), generateStream: vi.fn() } as unknown as Model;
}

describe('weaveDbModelResolver', () => {
  const candidates: ModelCandidate[] = [
    { id: 'gpt-4o', provider: 'openai' },
    { id: 'claude-3-5', provider: 'anthropic' },
  ];

  it('returns a routed Model when the routing brain picks one', async () => {
    const r = weaveDbModelResolver({
      listCandidates: async () => candidates,
      routeModel: async () => ({ provider: 'openai', modelId: 'gpt-4o' }),
      getOrCreateModel: async (provider, modelId) => fakeModel(`${provider}/${modelId}`),
    });
    const m = await r.resolve({ role: 'strategist' });
    expect(m).toBeDefined();
    expect((m as unknown as { id: string }).id).toBe('openai/gpt-4o');
  });

  it('passes role-based default taskType when capability hint is absent', async () => {
    const route = vi.fn().mockResolvedValue({ provider: 'openai', modelId: 'gpt-4o' });
    const r = weaveDbModelResolver({
      listCandidates: async () => candidates,
      routeModel: route,
      getOrCreateModel: async () => fakeModel('m'),
      roleTaskMap: { strategist: 'reasoning', validator: 'analysis' },
    });
    await r.resolve({ role: 'validator' });
    expect(route).toHaveBeenCalledWith(
      candidates,
      expect.objectContaining({ taskType: 'analysis', prompt: 'live-agent-validator' }),
    );
  });

  it('per-tick capability hint wins over role default', async () => {
    const route = vi.fn().mockResolvedValue({ provider: 'openai', modelId: 'gpt-4o' });
    const r = weaveDbModelResolver({
      listCandidates: async () => candidates,
      routeModel: route,
      getOrCreateModel: async () => fakeModel('m'),
      roleTaskMap: { strategist: 'reasoning' },
    });
    await r.resolve({ role: 'strategist', capability: { task: 'tool_use' } });
    expect(route).toHaveBeenCalledWith(
      candidates,
      expect.objectContaining({ taskType: 'tool_use' }),
    );
  });

  it('returns undefined when listCandidates returns empty', async () => {
    const r = weaveDbModelResolver({
      listCandidates: async () => [],
      routeModel: vi.fn(),
      getOrCreateModel: async () => fakeModel('m'),
    });
    const m = await r.resolve({});
    expect(m).toBeUndefined();
  });

  it('returns undefined when listCandidates throws', async () => {
    const log = vi.fn();
    const r = weaveDbModelResolver({
      listCandidates: async () => { throw new Error('db down'); },
      routeModel: vi.fn(),
      getOrCreateModel: async () => fakeModel('m'),
      log,
    });
    expect(await r.resolve({})).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('db down'));
  });

  it('returns undefined when routeModel returns null', async () => {
    const r = weaveDbModelResolver({
      listCandidates: async () => candidates,
      routeModel: async () => null,
      getOrCreateModel: async () => fakeModel('m'),
    });
    expect(await r.resolve({})).toBeUndefined();
  });

  it('returns undefined when routeModel throws', async () => {
    const log = vi.fn();
    const r = weaveDbModelResolver({
      listCandidates: async () => candidates,
      routeModel: async () => { throw new Error('rate-limited'); },
      getOrCreateModel: async () => fakeModel('m'),
      log,
    });
    expect(await r.resolve({})).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('rate-limited'));
  });

  it('returns undefined when getOrCreateModel throws', async () => {
    const r = weaveDbModelResolver({
      listCandidates: async () => candidates,
      routeModel: async () => ({ provider: 'openai', modelId: 'gpt-4o' }),
      getOrCreateModel: async () => { throw new Error('no api key'); },
    });
    expect(await r.resolve({})).toBeUndefined();
  });

  it('tags resolved model with provider/modelId by default', async () => {
    const m = fakeModel('original');
    const r = weaveDbModelResolver({
      listCandidates: async () => candidates,
      routeModel: async () => ({ provider: 'openai', modelId: 'gpt-4o' }),
      getOrCreateModel: async () => m,
    });
    const out = await r.resolve({});
    expect((out as unknown as { id: string }).id).toBe('openai/gpt-4o');
  });

  it('skips tagging when tagModelId=false', async () => {
    const m = fakeModel('original');
    const r = weaveDbModelResolver({
      listCandidates: async () => candidates,
      routeModel: async () => ({ provider: 'openai', modelId: 'gpt-4o' }),
      getOrCreateModel: async () => m,
      tagModelId: false,
    });
    const out = await r.resolve({});
    expect((out as unknown as { id: string }).id).toBe('original');
  });
});

describe('weaveAgentOverlayResolver', () => {
  const baseModel = fakeModel('base');
  const baseResolver = { resolve: vi.fn().mockResolvedValue(baseModel) };

  it('delegates to base when no agentId on context', async () => {
    const o = weaveAgentOverlayResolver({
      base: baseResolver,
      getAgentRow: vi.fn(),
    });
    const m = await o.resolve({});
    expect(m).toBe(baseModel);
  });

  it('delegates to base when getAgentRow returns null', async () => {
    const o = weaveAgentOverlayResolver({
      base: baseResolver,
      getAgentRow: async () => null,
    });
    expect(await o.resolve({ agentId: 'agent-1' })).toBe(baseModel);
  });

  it('bypasses base when row has model_pinned_id', async () => {
    baseResolver.resolve.mockClear();
    const pinned = fakeModel('pinned-x');
    const row: AgentModelFieldsRowLike & { id: string } = {
      id: 'agent-1',
      model_pinned_id: 'gpt-4o-2024-08',
    };
    const loadPinnedModel = vi.fn().mockResolvedValue(pinned);
    const o = weaveAgentOverlayResolver({
      base: baseResolver,
      getAgentRow: async () => row,
      loadPinnedModel,
    });
    const m = await o.resolve({ agentId: 'agent-1' });
    expect(m).toBe(pinned);
    expect(loadPinnedModel).toHaveBeenCalledWith('gpt-4o-2024-08');
    // Base must NOT be called when pinned wins.
    expect(baseResolver.resolve).not.toHaveBeenCalled();
  });

  it('falls back to base when loadPinnedModel throws', async () => {
    baseResolver.resolve.mockClear();
    const row: AgentModelFieldsRowLike & { id: string } = {
      id: 'agent-1',
      model_pinned_id: 'broken',
    };
    const o = weaveAgentOverlayResolver({
      base: baseResolver,
      getAgentRow: async () => row,
      loadPinnedModel: async () => { throw new Error('not found'); },
    });
    const m = await o.resolve({ agentId: 'agent-1' });
    expect(m).toBe(baseModel);
    expect(baseResolver.resolve).toHaveBeenCalled();
  });

  it('merges capability spec into ctx.capability before calling base', async () => {
    baseResolver.resolve.mockClear();
    const row: AgentModelFieldsRowLike & { id: string } = {
      id: 'agent-1',
      model_capability_json: JSON.stringify({ task: 'reasoning', toolUse: true }),
      model_routing_policy_key: 'high-quality',
    };
    const o = weaveAgentOverlayResolver({
      base: baseResolver,
      getAgentRow: async () => row,
    });
    await o.resolve({ agentId: 'agent-1', capability: { minContextTokens: 1000 } });
    expect(baseResolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        capability: expect.objectContaining({
          task: 'reasoning',
          toolUse: true,
          minContextTokens: 1000,
          hints: expect.objectContaining({ policyKey: 'high-quality' }),
        }),
      }),
    );
  });

  it('emits audit event with run_id and step_id when supplied', async () => {
    baseResolver.resolve.mockResolvedValue(baseModel);
    const events: ModelResolvedAuditEvent[] = [];
    const row: AgentModelFieldsRowLike & { id: string } = {
      id: 'agent-1',
      model_capability_json: JSON.stringify({ task: 'analysis' }),
    };
    const o = weaveAgentOverlayResolver({
      base: baseResolver,
      getAgentRow: async () => row,
      appendAuditEvent: async (ev) => { events.push(ev); },
      newId: () => 'evt-fixed',
    });
    await o.resolve({ agentId: 'agent-1', runId: 'run-1', stepId: 5 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'evt-fixed',
      run_id: 'run-1',
      step_id: '5',
      kind: 'model.resolved',
      agent_id: 'agent-1',
    });
    expect(events[0]?.summary).toMatch(/^routed:analysis/);
  });

  it('does not emit audit event when runId is missing', async () => {
    const writer = vi.fn();
    const row: AgentModelFieldsRowLike & { id: string } = {
      id: 'agent-1',
      model_capability_json: JSON.stringify({ task: 'analysis' }),
    };
    const o = weaveAgentOverlayResolver({
      base: { resolve: async () => baseModel },
      getAgentRow: async () => row,
      appendAuditEvent: writer,
    });
    await o.resolve({ agentId: 'agent-1' });
    expect(writer).not.toHaveBeenCalled();
  });

  it('swallows audit writer failures', async () => {
    const row: AgentModelFieldsRowLike & { id: string } = {
      id: 'agent-1',
      model_capability_json: JSON.stringify({ task: 'analysis' }),
    };
    const o = weaveAgentOverlayResolver({
      base: { resolve: async () => baseModel },
      getAgentRow: async () => row,
      appendAuditEvent: async () => { throw new Error('audit table down'); },
    });
    // Should not throw.
    await expect(o.resolve({ agentId: 'agent-1', runId: 'r' })).resolves.toBe(baseModel);
  });

  it('default source delegates untouched and audits as "default"', async () => {
    baseResolver.resolve.mockClear();
    const events: ModelResolvedAuditEvent[] = [];
    const row: AgentModelFieldsRowLike & { id: string } = { id: 'agent-1' };
    const o = weaveAgentOverlayResolver({
      base: baseResolver,
      getAgentRow: async () => row,
      appendAuditEvent: async (ev) => { events.push(ev); },
    });
    await o.resolve({ agentId: 'agent-1', runId: 'run-1' });
    expect(baseResolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1' }),
    );
    expect(events[0]?.summary).toBe('default');
  });

  it('falls back to base when getAgentRow throws', async () => {
    baseResolver.resolve.mockClear();
    baseResolver.resolve.mockResolvedValue(baseModel);
    const o = weaveAgentOverlayResolver({
      base: baseResolver,
      getAgentRow: async () => { throw new Error('db down'); },
    });
    expect(await o.resolve({ agentId: 'agent-1' })).toBe(baseModel);
  });
});
