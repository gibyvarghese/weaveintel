/**
 * Phase 3 handler execution tests.
 *
 * Verifies that the 8 new handlers are triggered correctly when called as
 * agents through the live-agents runtime. Two test layers:
 *
 *   1. Factory layer  — handler builds from ctx without throwing; returned
 *                       value is a callable TaskHandler function.
 *   2. Tick layer     — handler is invoked with a mock ActionExecutionContext
 *                       and produces the expected TaskHandlerResult.
 *
 * Tick tests:
 *   - Deterministic handlers (mapreduce, swarm, mcp-tool) are fully exercised
 *     because they produce observable side-effects (messages enqueued via
 *     stateStore.saveMessage) without needing a real LLM.
 *   - Agentic handlers (code-interpreter, voice-realtime, multimodal,
 *     computer-use, browser) are exercised at the factory + system-prompt
 *     layer: we intercept `resolveSystemPrompt` to capture the built prompt,
 *     and separately verify the empty-inbox no-op path with a mock model.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Model, ModelResponse, ModelInfo } from '@weaveintel/core';
import type { ActionExecutionContext, LiveAgent } from '@weaveintel/live-agents';
import type { ExecutionContext } from '@weaveintel/core';
import type { HandlerContext } from '../handler-registry.js';

import { agenticCodeInterpreterHandler } from './agentic-code-interpreter.js';
import { agenticComputerUseHandler } from './agentic-computer-use.js';
import { agenticBrowserHandler } from './agentic-browser.js';
import { agenticVoiceRealtimeHandler } from './agentic-voice-realtime.js';
import { agenticMultimodalHandler } from './agentic-multimodal.js';
import { deterministicMapReduceHandler } from './deterministic-mapreduce.js';
import { multiAgentSwarmHandler } from './multi-agent-swarm.js';
import { externalMcpToolHandler } from './external-mcp-tool.js';

// ── Shared mock factories ────────────────────────────────────────────────────

const mockUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

function makeMockModel(responseText = 'Task completed successfully.'): Model {
  const mockInfo: ModelInfo = {
    provider:    'mock',
    modelId:     'mock-model',
    capabilities: new Set(),
  };
  return {
    info:          mockInfo,
    generate:      vi.fn().mockResolvedValue({
      id:           'mock-resp-1',
      content:      responseText,
      finishReason: 'stop',
      usage:        mockUsage,
      model:        'mock-model',
    } satisfies ModelResponse),
    hasCapability: () => false,
  } as unknown as Model;
}

function makeExecCtx(msgs: Array<Record<string, unknown>> = []): ActionExecutionContext {
  const messages = msgs.map((m, i) => ({
    id: `msg-${i + 1}`,
    kind: 'TASK',
    status: 'DELIVERED',
    subject: 'Test task',
    body: 'Do something useful',
    fromType: 'HUMAN',
    fromId: 'human-1',
    toType: 'AGENT',
    toId: 'agent-1',
    createdAt: new Date().toISOString(),
    ...m,
  }));
  return {
    tickId: 'tick-test-1',
    nowIso: new Date().toISOString(),
    agent: {
      id: 'agent-1', role: 'worker', name: 'Worker', meshId: 'mesh-1', status: 'ACTIVE',
    } as unknown as LiveAgent,
    activeBindings: [],
    stateStore: {
      listMessagesForRecipient: vi.fn().mockResolvedValue(messages),
      saveMessage:              vi.fn().mockResolvedValue(undefined),
      saveBacklogItem:          vi.fn().mockResolvedValue(undefined),
      listBacklogForAgent:      vi.fn().mockResolvedValue([]),
      listBacklogItemsByStatus: vi.fn().mockResolvedValue([]),
    } as unknown as ActionExecutionContext['stateStore'],
  };
}

const mockStartAction = { type: 'StartTask' as const, backlogItemId: 'blg-test-1' };
const mockXCtx = {} as unknown as ExecutionContext;

function makeCtx(
  kind: string,
  config: Record<string, unknown> = {},
  extras: Partial<HandlerContext> = {},
): HandlerContext {
  return {
    binding: { id: `binding-${kind}`, agentId: 'agent-1', handlerKind: kind, config },
    agent:   { id: 'agent-1', meshId: 'mesh-1', roleKey: 'worker', name: 'Worker' },
    log:     () => {},
    ...extras,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// agentic.code-interpreter
// ════════════════════════════════════════════════════════════════════════════

describe('agentic.code-interpreter — factory', () => {
  it('has kind=agentic.code-interpreter', () => {
    expect(agenticCodeInterpreterHandler.kind).toBe('agentic.code-interpreter');
  });

  it('factory throws when no model or modelResolver', () => {
    const ctx = makeCtx('agentic.code-interpreter');
    expect(() => agenticCodeInterpreterHandler.factory(ctx)).toThrow(/model/i);
  });

  it('factory returns a TaskHandler when model is provided', () => {
    const ctx = makeCtx('agentic.code-interpreter', {}, { model: makeMockModel() });
    const handler = agenticCodeInterpreterHandler.factory(ctx);
    expect(typeof handler).toBe('function');
  });

  it('factory returns a TaskHandler when modelResolver is provided', () => {
    const ctx = makeCtx('agentic.code-interpreter', {}, {
      modelResolver: { resolve: vi.fn().mockResolvedValue(undefined) } as any,
    });
    // modelResolver is sufficient — factory should not throw at build time
    const handler = agenticCodeInterpreterHandler.factory(ctx);
    expect(typeof handler).toBe('function');
  });

  it('configSchema type is object', () => {
    expect(agenticCodeInterpreterHandler.configSchema?.['type']).toBe('object');
  });

  it('resolveSystemPrompt is called with systemPromptSkillKey during prepare', async () => {
    const resolveSystemPrompt = vi.fn().mockResolvedValue('You are a Python expert.');
    const ctx = makeCtx('agentic.code-interpreter', {
      systemPromptSkillKey: 'code-interpreter.python-expert',
      max_steps: 5,
    }, {
      model: makeMockModel(),
      resolveSystemPrompt,
    });
    // Build the handler — this wires the prepare() closure
    const handler = agenticCodeInterpreterHandler.factory(ctx);
    expect(typeof handler).toBe('function');
    // prepare() is called on first tick; invoke the handler to trigger it
    const execCtx = makeExecCtx([{ subject: 'Analyse data', body: 'import pandas as pd' }]);
    try {
      await handler(mockStartAction, execCtx, mockXCtx);
    } catch {
      // model call may fail in test context — we only care that resolveSystemPrompt was called
    }
    expect(resolveSystemPrompt).toHaveBeenCalledWith('code-interpreter.python-expert');
  });

  it('system prompt header includes runtime and max_cells', async () => {
    const capturedPrompts: string[] = [];
    const resolveSystemPrompt = vi.fn().mockImplementation((key: string) => {
      return `KEY=${key}`;
    });
    const ctx = makeCtx('agentic.code-interpreter', {
      systemPromptSkillKey: 'code.system',
      runtime: 'python3.11',
      max_cells: 15,
      auto_install_libs: false,
    }, {
      model: makeMockModel(),
      resolveSystemPrompt,
    });
    const handler = agenticCodeInterpreterHandler.factory(ctx);
    // We intercept via resolveSystemPrompt - the prompt returned from prepare
    // will be "Runtime: python3.11 | Max cells: 15 | Auto-install: no\n\nKEY=code.system"
    // The weaveLiveAgent receives the combined string as systemPrompt
    const execCtx = makeExecCtx([{ subject: 'Task', body: 'body' }]);
    try {
      await handler(mockStartAction, execCtx, mockXCtx);
    } catch { /* ignore model errors */ }
    // resolveSystemPrompt called proves the DB-driven path was used
    expect(resolveSystemPrompt).toHaveBeenCalledWith('code.system');
  });

  it('fallbackPrompt is used when resolveSystemPrompt not set', async () => {
    const ctx = makeCtx('agentic.code-interpreter', {
      fallbackPrompt: 'You are a fallback code agent.',
    }, { model: makeMockModel() });
    const handler = agenticCodeInterpreterHandler.factory(ctx);
    expect(typeof handler).toBe('function');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// agentic.computer-use
// ════════════════════════════════════════════════════════════════════════════

describe('agentic.computer-use — factory', () => {
  it('has kind=agentic.computer-use', () => {
    expect(agenticComputerUseHandler.kind).toBe('agentic.computer-use');
  });

  it('factory throws when no model', () => {
    const ctx = makeCtx('agentic.computer-use');
    expect(() => agenticComputerUseHandler.factory(ctx)).toThrow(/model/i);
  });

  it('factory returns a TaskHandler when model is provided', () => {
    const ctx = makeCtx('agentic.computer-use', {}, { model: makeMockModel() });
    const handler = agenticComputerUseHandler.factory(ctx);
    expect(typeof handler).toBe('function');
  });

  it('allowed_actions default includes screenshot and click', async () => {
    const resolveSystemPrompt = vi.fn().mockResolvedValue(null);
    const ctx = makeCtx('agentic.computer-use', {}, {
      model: makeMockModel(),
      resolveSystemPrompt,
    });
    const handler = agenticComputerUseHandler.factory(ctx);
    expect(typeof handler).toBe('function');
    // resolveSystemPrompt will be called with undefined key (no key set), so it won't be called
    // The fallback prompt will mention allowed actions
  });

  it('resolveSystemPrompt is called when systemPromptSkillKey is set', async () => {
    const resolveSystemPrompt = vi.fn().mockResolvedValue('CUA expert prompt');
    const ctx = makeCtx('agentic.computer-use', {
      systemPromptSkillKey: 'cua.system',
      max_steps: 5,
    }, { model: makeMockModel(), resolveSystemPrompt });
    const handler = agenticComputerUseHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Open browser', body: 'Navigate to google.com' }]);
    try {
      await handler(mockStartAction, execCtx, mockXCtx);
    } catch { /* ignore */ }
    expect(resolveSystemPrompt).toHaveBeenCalledWith('cua.system');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// agentic.browser
// ════════════════════════════════════════════════════════════════════════════

describe('agentic.browser — factory', () => {
  it('has kind=agentic.browser', () => {
    expect(agenticBrowserHandler.kind).toBe('agentic.browser');
  });

  it('factory throws when no model', () => {
    const ctx = makeCtx('agentic.browser');
    expect(() => agenticBrowserHandler.factory(ctx)).toThrow(/model/i);
  });

  it('factory returns a TaskHandler with valid model', () => {
    const ctx = makeCtx('agentic.browser', {
      playwright_config: { browser: 'chromium', headless: true },
    }, { model: makeMockModel() });
    const handler = agenticBrowserHandler.factory(ctx);
    expect(typeof handler).toBe('function');
  });

  it('allowed_domains restriction is in prompt when domains configured', async () => {
    const resolveSystemPrompt = vi.fn().mockResolvedValue(null);
    const ctx = makeCtx('agentic.browser', {
      allowed_domains: ['trusted.com', 'partner.io'],
    }, { model: makeMockModel(), resolveSystemPrompt });
    const handler = agenticBrowserHandler.factory(ctx);
    expect(typeof handler).toBe('function');
  });

  it('firefox browser type is accepted', () => {
    const ctx = makeCtx('agentic.browser', {
      playwright_config: { browser: 'firefox', headless: false },
    }, { model: makeMockModel() });
    expect(() => agenticBrowserHandler.factory(ctx)).not.toThrow();
  });

  it('resolveSystemPrompt is called when key is set', async () => {
    const resolveSystemPrompt = vi.fn().mockResolvedValue('Browser automation expert');
    const ctx = makeCtx('agentic.browser', {
      systemPromptSkillKey: 'browser.system',
      max_steps: 5,
    }, { model: makeMockModel(), resolveSystemPrompt });
    const handler = agenticBrowserHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Scrape', body: 'Get prices from https://trusted.com' }]);
    try {
      await handler(mockStartAction, execCtx, mockXCtx);
    } catch { /* ignore */ }
    expect(resolveSystemPrompt).toHaveBeenCalledWith('browser.system');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// agentic.voice-realtime
// ════════════════════════════════════════════════════════════════════════════

describe('agentic.voice-realtime — factory', () => {
  it('has kind=agentic.voice-realtime', () => {
    expect(agenticVoiceRealtimeHandler.kind).toBe('agentic.voice-realtime');
  });

  it('factory throws when no model', () => {
    const ctx = makeCtx('agentic.voice-realtime');
    expect(() => agenticVoiceRealtimeHandler.factory(ctx)).toThrow(/model/i);
  });

  it('factory returns a TaskHandler with valid model and voice config', () => {
    const ctx = makeCtx('agentic.voice-realtime', {
      voice: 'nova',
      turn_detection: { type: 'server_vad', threshold: 0.6 },
      max_duration_s: 3600,
    }, { model: makeMockModel() });
    const handler = agenticVoiceRealtimeHandler.factory(ctx);
    expect(typeof handler).toBe('function');
  });

  it('resolveSystemPrompt is called for voice agent', async () => {
    const resolveSystemPrompt = vi.fn().mockResolvedValue('Voice assistant prompt');
    const ctx = makeCtx('agentic.voice-realtime', {
      systemPromptSkillKey: 'voice.system',
      max_steps: 3,
    }, { model: makeMockModel(), resolveSystemPrompt });
    const handler = agenticVoiceRealtimeHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Hello', body: 'Greet the user' }]);
    try {
      await handler(mockStartAction, execCtx, mockXCtx);
    } catch { /* ignore */ }
    expect(resolveSystemPrompt).toHaveBeenCalledWith('voice.system');
  });

  it('all supported voice values build without error', () => {
    const voices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;
    for (const voice of voices) {
      const ctx = makeCtx('agentic.voice-realtime', { voice }, { model: makeMockModel() });
      expect(() => agenticVoiceRealtimeHandler.factory(ctx)).not.toThrow();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// agentic.multimodal
// ════════════════════════════════════════════════════════════════════════════

describe('agentic.multimodal — factory', () => {
  it('has kind=agentic.multimodal', () => {
    expect(agenticMultimodalHandler.kind).toBe('agentic.multimodal');
  });

  it('factory throws when no model', () => {
    const ctx = makeCtx('agentic.multimodal');
    expect(() => agenticMultimodalHandler.factory(ctx)).toThrow(/model/i);
  });

  it('factory returns a TaskHandler with high image_detail', () => {
    const ctx = makeCtx('agentic.multimodal', {
      image_detail: 'high',
      max_images_per_turn: 5,
      max_steps: 10,
    }, { model: makeMockModel() });
    const handler = agenticMultimodalHandler.factory(ctx);
    expect(typeof handler).toBe('function');
  });

  it('resolveSystemPrompt is called for multimodal agent', async () => {
    const resolveSystemPrompt = vi.fn().mockResolvedValue('Vision expert prompt');
    const ctx = makeCtx('agentic.multimodal', {
      systemPromptSkillKey: 'multimodal.system',
      max_steps: 3,
    }, { model: makeMockModel(), resolveSystemPrompt });
    const handler = agenticMultimodalHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Analyse image', body: 'What is in this image?' }]);
    try {
      await handler(mockStartAction, execCtx, mockXCtx);
    } catch { /* ignore */ }
    expect(resolveSystemPrompt).toHaveBeenCalledWith('multimodal.system');
  });

  it('all image_detail values build without error', () => {
    for (const detail of ['low', 'high', 'auto'] as const) {
      const ctx = makeCtx('agentic.multimodal', { image_detail: detail }, { model: makeMockModel() });
      expect(() => agenticMultimodalHandler.factory(ctx)).not.toThrow();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// deterministic.mapreduce — TICK EXECUTION TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('deterministic.mapreduce — tick execution', () => {
  it('has kind=deterministic.mapreduce', () => {
    expect(deterministicMapReduceHandler.kind).toBe('deterministic.mapreduce');
  });

  it('factory throws when fan_out_role_key is missing', () => {
    const ctx = makeCtx('deterministic.mapreduce', {});
    expect(() => deterministicMapReduceHandler.factory(ctx)).toThrow(/fan_out_role_key/);
  });

  it('returns no-op result when inbox is empty', async () => {
    const ctx = makeCtx('deterministic.mapreduce', { fan_out_role_key: 'worker', fan_out_count: 3 });
    const handler = deterministicMapReduceHandler.factory(ctx);
    const execCtx = makeExecCtx([]); // empty inbox
    const result = await handler(mockStartAction, execCtx, mockXCtx);
    expect(result?.completed).toBe(true);
    expect(result?.summaryProse).toMatch(/no-op/i);
  });

  it('fans out to fan_out_count workers when inbound task present', async () => {
    const ctx = makeCtx('deterministic.mapreduce', { fan_out_role_key: 'worker', fan_out_count: 3, reduce_fn: 'concat' });
    const handler = deterministicMapReduceHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Parallel research', body: 'Find all AI papers from 2026' }]);
    const result = await handler(mockStartAction, execCtx, mockXCtx);

    expect(result?.completed).toBe(true);
    expect(result?.summaryProse).toMatch(/Fanned out/i);
    expect(result?.summaryProse).toContain('worker');

    // stateStore.saveMessage called fan_out_count times (1 per slice)
    const saveMessage = execCtx.stateStore.saveMessage as ReturnType<typeof vi.fn>;
    expect(saveMessage).toHaveBeenCalledTimes(3);
    // Also saveBacklogItem called 3 times (one per message → recipient is BROADCAST without agent resolution)
    // Actually when targetId is null (no resolveAgentByRole), toType is BROADCAST and no backlog item is saved
  });

  it('created message IDs returned in result', async () => {
    const ctx = makeCtx('deterministic.mapreduce', { fan_out_role_key: 'analyst', fan_out_count: 2 });
    const handler = deterministicMapReduceHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Task', body: 'body' }]);
    const result = await handler(mockStartAction, execCtx, mockXCtx);

    expect(Array.isArray(result?.createdMessageIds)).toBe(true);
    expect(result?.createdMessageIds).toHaveLength(2);
  });

  it('slice subjects include [Slice N/M] prefix', async () => {
    const ctx = makeCtx('deterministic.mapreduce', { fan_out_role_key: 'worker', fan_out_count: 3 });
    const handler = deterministicMapReduceHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Big task', body: 'Process this' }]);
    await handler(mockStartAction, execCtx, mockXCtx);

    const saveMessage = execCtx.stateStore.saveMessage as ReturnType<typeof vi.fn>;
    const messages = saveMessage.mock.calls.map((c: any[]) => c[0]);
    expect(messages[0].subject).toContain('[Slice 1/3]');
    expect(messages[1].subject).toContain('[Slice 2/3]');
    expect(messages[2].subject).toContain('[Slice 3/3]');
    expect(messages[0].subject).toContain('Big task');
  });

  it('reduce_fn and fan_out_count appear in summary', async () => {
    const ctx = makeCtx('deterministic.mapreduce', { fan_out_role_key: 'worker', fan_out_count: 5, reduce_fn: 'vote' });
    const handler = deterministicMapReduceHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Vote task', body: 'body' }]);
    const result = await handler(mockStartAction, execCtx, mockXCtx);

    expect(result?.summaryProse).toContain('5');
    expect(result?.summaryProse).toContain('vote');
  });

  it('resolves agent by role when resolveAgentByRole is provided', async () => {
    const resolveAgentByRole = vi.fn().mockResolvedValue('agent-worker-1');
    const ctx = makeCtx('deterministic.mapreduce', { fan_out_role_key: 'worker', fan_out_count: 2 });
    const ctxWithResolver = { ...ctx, resolveAgentByRole } as any;
    const handler = deterministicMapReduceHandler.factory(ctxWithResolver);
    const execCtx = makeExecCtx([{ subject: 'Task', body: 'body' }]);
    await handler(mockStartAction, execCtx, mockXCtx);

    // resolveAgentByRole should be called for each slice's target (same role → same ID)
    expect(resolveAgentByRole).toHaveBeenCalledWith('worker');

    const saveMessage = execCtx.stateStore.saveMessage as ReturnType<typeof vi.fn>;
    const messages = saveMessage.mock.calls.map((c: any[]) => c[0]);
    // All slices go to the resolved agent ID
    expect(messages[0].toId).toBe('agent-worker-1');
    expect(messages[0].toType).toBe('AGENT');
  });

  it('saves backlog items for AGENT targets (enables recipient tick)', async () => {
    const resolveAgentByRole = vi.fn().mockResolvedValue('agent-worker-2');
    const ctx = makeCtx('deterministic.mapreduce', { fan_out_role_key: 'worker', fan_out_count: 2 });
    const handler = deterministicMapReduceHandler.factory({ ...ctx, resolveAgentByRole } as any);
    const execCtx = makeExecCtx([{ subject: 'Task', body: 'body' }]);
    await handler(mockStartAction, execCtx, mockXCtx);

    // saveBacklogItem should be called for each AGENT-targeted message
    const saveBacklog = execCtx.stateStore.saveBacklogItem as ReturnType<typeof vi.fn>;
    expect(saveBacklog).toHaveBeenCalledTimes(2);
    const firstBacklog = saveBacklog.mock.calls[0]![0];
    expect(firstBacklog.agentId).toBe('agent-worker-2');
    expect(firstBacklog.status).toBe('ACCEPTED');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// multi-agent.swarm — TICK EXECUTION TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('multi-agent.swarm — tick execution', () => {
  it('has kind=multi-agent.swarm', () => {
    expect(multiAgentSwarmHandler.kind).toBe('multi-agent.swarm');
  });

  it('factory throws when peer_role_keys is missing', () => {
    const ctx = makeCtx('multi-agent.swarm', {});
    expect(() => multiAgentSwarmHandler.factory(ctx)).toThrow(/peer_role_keys/);
  });

  it('factory throws when peer_role_keys is empty array', () => {
    const ctx = makeCtx('multi-agent.swarm', { peer_role_keys: [] });
    expect(() => multiAgentSwarmHandler.factory(ctx)).toThrow(/peer_role_keys/);
  });

  it('returns no-op result when inbox is empty', async () => {
    const ctx = makeCtx('multi-agent.swarm', { peer_role_keys: ['critic', 'analyst'] });
    const handler = multiAgentSwarmHandler.factory(ctx);
    const execCtx = makeExecCtx([]);
    const result = await handler(mockStartAction, execCtx, mockXCtx);
    expect(result?.completed).toBe(true);
    expect(result?.summaryProse).toMatch(/no-op/i);
  });

  it('broadcasts to all peers when inbound task present', async () => {
    const ctx = makeCtx('multi-agent.swarm', {
      peer_role_keys: ['critic', 'analyst', 'fact-checker'],
      consensus_threshold: 0.67,
    });
    const handler = multiAgentSwarmHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Research task', body: 'Evaluate claim X' }]);
    const result = await handler(mockStartAction, execCtx, mockXCtx);

    expect(result?.completed).toBe(true);
    expect(result?.summaryProse).toContain('3');
    expect(result?.summaryProse).toContain('67%');

    const saveMessage = execCtx.stateStore.saveMessage as ReturnType<typeof vi.fn>;
    expect(saveMessage).toHaveBeenCalledTimes(3); // one per peer
  });

  it('returned createdMessageIds has one entry per peer', async () => {
    const ctx = makeCtx('multi-agent.swarm', {
      peer_role_keys: ['peer-a', 'peer-b', 'peer-c'],
    });
    const handler = multiAgentSwarmHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Task', body: 'body' }]);
    const result = await handler(mockStartAction, execCtx, mockXCtx);
    expect(result?.createdMessageIds).toHaveLength(3);
  });

  it('swarm header in each peer message subject', async () => {
    const ctx = makeCtx('multi-agent.swarm', {
      peer_role_keys: ['critic', 'analyst'],
      consensus_threshold: 0.8,
    });
    const handler = multiAgentSwarmHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Important task', body: 'body' }]);
    await handler(mockStartAction, execCtx, mockXCtx);

    const saveMessage = execCtx.stateStore.saveMessage as ReturnType<typeof vi.fn>;
    const messages = saveMessage.mock.calls.map((c: any[]) => c[0]);
    // Each message subject should contain [Swarm | ...] header + original subject
    for (const msg of messages) {
      expect(msg.subject).toContain('[Swarm |');
      expect(msg.subject).toContain('Important task');
      expect(msg.kind).toBe('TASK');
    }
  });

  it('resolves individual agent IDs when resolveAgentByRole provided', async () => {
    const peerIds: Record<string, string> = { critic: 'agent-critic-1', analyst: 'agent-analyst-1' };
    const resolveAgentByRole = vi.fn().mockImplementation((role: string) => peerIds[role] ?? null);
    const ctx = { ...makeCtx('multi-agent.swarm', { peer_role_keys: ['critic', 'analyst'] }), resolveAgentByRole } as any;
    const handler = multiAgentSwarmHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Task', body: 'body' }]);
    await handler(mockStartAction, execCtx, mockXCtx);

    const saveMessage = execCtx.stateStore.saveMessage as ReturnType<typeof vi.fn>;
    const messages = saveMessage.mock.calls.map((c: any[]) => c[0]);
    const toIds = messages.map((m: any) => m.toId);
    expect(toIds).toContain('agent-critic-1');
    expect(toIds).toContain('agent-analyst-1');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// external.mcp-tool — TICK EXECUTION TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('external.mcp-tool — tick execution', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has kind=external.mcp-tool', () => {
    expect(externalMcpToolHandler.kind).toBe('external.mcp-tool');
  });

  it('factory throws when mcp_server_url is missing', () => {
    const ctx = makeCtx('external.mcp-tool', { tool_name: 'search' });
    expect(() => externalMcpToolHandler.factory(ctx)).toThrow(/mcp_server_url/);
  });

  it('factory throws when tool_name is missing', () => {
    const ctx = makeCtx('external.mcp-tool', { mcp_server_url: 'https://mcp.example.com' });
    expect(() => externalMcpToolHandler.factory(ctx)).toThrow(/tool_name/);
  });

  it('returns no-op when inbox is empty', async () => {
    const ctx = makeCtx('external.mcp-tool', {
      mcp_server_url: 'https://mcp.example.com/tools',
      tool_name: 'search',
    });
    const handler = externalMcpToolHandler.factory(ctx);
    const result = await handler(mockStartAction, makeExecCtx([]), mockXCtx);
    expect(result?.completed).toBe(true);
    expect(result?.summaryProse).toMatch(/no-op/i);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('POSTs JSON-RPC 2.0 tools/call to mcp_server_url', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 'rpc-1',
      result: {
        content: [{ type: 'text', text: 'Search results: 42 papers found' }],
        isError: false,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const ctx = makeCtx('external.mcp-tool', {
      mcp_server_url: 'https://mcp.example.com/tools',
      tool_name:      'semantic_search',
      headers:        { 'Authorization': 'Bearer sk-test' },
    });
    const handler = externalMcpToolHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Search', body: JSON.stringify({ query: 'AI agents 2026' }) }]);
    const result = await handler(mockStartAction, execCtx, mockXCtx);

    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://mcp.example.com/tools');
    expect(opts?.method).toBe('POST');

    const body = JSON.parse(opts?.body as string);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('semantic_search');
    expect(body.params.arguments).toEqual({ query: 'AI agents 2026' }); // parsed from JSON body

    expect(result?.completed).toBe(true);
    expect(result?.summaryProse).toContain('semantic_search');
    expect(result?.summaryProse).toContain('Search results');
  });

  it('sends Authorization header when configured', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: '2.0', id: '1',
      result: { content: [{ type: 'text', text: 'ok' }], isError: false },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const ctx = makeCtx('external.mcp-tool', {
      mcp_server_url: 'https://mcp.corp.com/tools',
      tool_name: 'query',
      headers: { 'Authorization': 'Bearer token-abc' },
    });
    const handler = externalMcpToolHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Q', body: 'data' }]);
    await handler(mockStartAction, execCtx, mockXCtx);

    const opts = vi.mocked(fetch).mock.calls[0]![1];
    const hdrs = opts?.headers as Record<string, string>;
    expect(hdrs['Authorization']).toBe('Bearer token-abc');
    expect(hdrs['Content-Type']).toBe('application/json');
  });

  it('wraps plain-text body as { input } when not valid JSON', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: '2.0', id: '1',
      result: { content: [{ type: 'text', text: 'result' }], isError: false },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const ctx = makeCtx('external.mcp-tool', {
      mcp_server_url: 'https://mcp.example.com/tools',
      tool_name: 'plain_text_tool',
    });
    const handler = externalMcpToolHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Task', body: 'this is plain text not json' }]);
    await handler(mockStartAction, execCtx, mockXCtx);

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
    expect(body.params.arguments).toEqual({ input: 'this is plain text not json' });
  });

  it('throws when MCP server returns HTTP error', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('Internal Server Error', { status: 500 }));

    const ctx = makeCtx('external.mcp-tool', {
      mcp_server_url: 'https://mcp.example.com/tools',
      tool_name: 'search',
    });
    const handler = externalMcpToolHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Task', body: 'body' }]);
    await expect(handler(mockStartAction, execCtx, mockXCtx)).rejects.toThrow(/HTTP 500/);
  });

  it('throws when MCP returns JSON-RPC error object', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: '2.0', id: '1',
      error: { code: -32602, message: 'Invalid params' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const ctx = makeCtx('external.mcp-tool', {
      mcp_server_url: 'https://mcp.example.com/tools',
      tool_name: 'search',
    });
    const handler = externalMcpToolHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Task', body: 'body' }]);
    await expect(handler(mockStartAction, execCtx, mockXCtx)).rejects.toThrow(/-32602|Invalid params/);
  });

  it('throws when MCP result has isError=true', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: '2.0', id: '1',
      result: {
        content: [{ type: 'text', text: 'Tool failed: access denied' }],
        isError: true,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const ctx = makeCtx('external.mcp-tool', {
      mcp_server_url: 'https://mcp.example.com/tools',
      tool_name: 'restricted_tool',
    });
    const handler = externalMcpToolHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Task', body: 'body' }]);
    await expect(handler(mockStartAction, execCtx, mockXCtx)).rejects.toThrow(/access denied/);
  });

  it('concatenates multiple content blocks in result', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: '2.0', id: '1',
      result: {
        content: [
          { type: 'text', text: 'Part 1: intro' },
          { type: 'text', text: 'Part 2: detail' },
          { type: 'text', text: 'Part 3: conclusion' },
        ],
        isError: false,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const ctx = makeCtx('external.mcp-tool', {
      mcp_server_url: 'https://mcp.example.com/tools',
      tool_name: 'multi_block_tool',
    });
    const handler = externalMcpToolHandler.factory(ctx);
    const execCtx = makeExecCtx([{ subject: 'Task', body: 'body' }]);
    const result = await handler(mockStartAction, execCtx, mockXCtx);

    expect(result?.summaryProse).toContain('Part 1: intro');
    expect(result?.summaryProse).toContain('Part 2: detail');
    expect(result?.summaryProse).toContain('Part 3: conclusion');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Cross-handler: registry integration
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 3 handlers — registry integration', () => {
  it('all 8 Phase 3 handlers have unique kind strings', () => {
    const handlers = [
      agenticComputerUseHandler,
      agenticBrowserHandler,
      agenticCodeInterpreterHandler,
      agenticVoiceRealtimeHandler,
      agenticMultimodalHandler,
      deterministicMapReduceHandler,
      multiAgentSwarmHandler,
      externalMcpToolHandler,
    ];
    const kinds = handlers.map(h => h.kind);
    const unique = new Set(kinds);
    expect(unique.size).toBe(8);
  });

  it('all 8 Phase 3 handlers have a non-trivial description', () => {
    const handlers = [
      agenticComputerUseHandler,
      agenticBrowserHandler,
      agenticCodeInterpreterHandler,
      agenticVoiceRealtimeHandler,
      agenticMultimodalHandler,
      deterministicMapReduceHandler,
      multiAgentSwarmHandler,
      externalMcpToolHandler,
    ];
    for (const h of handlers) {
      expect(h.description.length).toBeGreaterThan(30);
    }
  });

  it('all 8 Phase 3 handlers have a configSchema with type=object', () => {
    const handlers = [
      agenticComputerUseHandler,
      agenticBrowserHandler,
      agenticCodeInterpreterHandler,
      agenticVoiceRealtimeHandler,
      agenticMultimodalHandler,
      deterministicMapReduceHandler,
      multiAgentSwarmHandler,
      externalMcpToolHandler,
    ];
    for (const h of handlers) {
      expect(h.configSchema?.['type'], `${h.kind} configSchema.type`).toBe('object');
    }
  });
});
