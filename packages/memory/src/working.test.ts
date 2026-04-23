import { describe, expect, it } from 'vitest';
import { weaveContext } from '@weaveintel/core';
import {
  createContextAssembler,
  createDefaultContextCompressors,
  createNoopCompressor,
  weaveWorkingMemory,
} from './working.js';

describe('@weaveintel/memory working memory', () => {
  it('supports patch, checkpoint, and restore lifecycle', async () => {
    const memory = weaveWorkingMemory();
    const ctx = weaveContext({ userId: 'agent:researcher-1' });

    const patched = await memory.patch(ctx, 'agent-1', [
      { op: 'set', key: 'task', value: 'analyze inbox triage' },
      { op: 'merge', value: { blockedOn: 'account-binding' } },
    ]);

    expect(patched.content['task']).toBe('analyze inbox triage');
    expect(patched.content['blockedOn']).toBe('account-binding');

    const checkpoint = await memory.checkpoint(ctx, 'agent-1');
    const restored = await memory.restore(ctx, 'agent-1', checkpoint.id);

    expect(restored).not.toBeNull();
    expect(restored?.content['task']).toBe('analyze inbox triage');
  });

  it('provides a usable no-op compressor for phase 1', async () => {
    const compressor = createNoopCompressor();
    const artefact = await compressor.compress({
      agentId: 'agent-1',
      messages: [
        {
          id: 'msg-1',
          type: 'conversation',
          content: 'Investigate customer escalation and summarize timeline.',
          metadata: {},
          createdAt: new Date().toISOString(),
        },
      ],
    }, weaveContext());

    const rendered = await compressor.render([artefact], 200, weaveContext());
    expect(rendered).toContain('Investigate customer escalation');
  });

  it('ships ten default compressors for phase 9', () => {
    const compressors = createDefaultContextCompressors();
    const ids = new Set(compressors.map((compressor) => compressor.id));

    expect(compressors).toHaveLength(10);
    expect(ids.size).toBe(10);
    expect(ids.has('hierarchical-summarisation')).toBe(true);
    expect(ids.has('contract-anchored-weighting')).toBe(true);
  });

  it('assembles weighted context within token budget', async () => {
    const assembler = createContextAssembler();
    const ctx = weaveContext();
    const input = {
      agentId: 'agent-1',
      messages: [
        {
          id: 'msg-1',
          type: 'conversation' as const,
          content: 'Resolved inbox triage and updated escalation owners.',
          metadata: {},
          createdAt: '2025-01-01T00:00:00.000Z',
        },
        {
          id: 'msg-2',
          type: 'conversation' as const,
          content: 'Documented API latency regression and opened follow-up task.',
          metadata: {},
          createdAt: '2025-01-02T00:00:00.000Z',
        },
      ],
      episodicEvents: [
        {
          id: 'ep-1',
          type: 'episodic' as const,
          content: 'Emergency escalation handled under manual override.',
          metadata: {},
          createdAt: '2025-01-03T00:00:00.000Z',
        },
      ],
      workingState: {
        lane: 'ops',
      },
      metadata: {
        objectives: 'Reduce unresolved incidents and maintain SLA compliance.',
      },
    };

    const assembled = await assembler.assemble(input, {
      profile: 'standard',
      tokenBudget: 120,
      weighting: [{ id: 'episodic-memory' }, { id: 'contract-anchored-weighting' }],
    }, ctx);

    expect(assembled.artefacts).toHaveLength(2);
    expect(assembled.rendered).toContain('Episodic events');
    expect(assembled.rendered).toContain('Objective anchor');
    expect(assembled.rendered.length).toBeLessThanOrEqual(120 * 4);
  });

  it('is deterministic for identical compression input', async () => {
    const compressor = createDefaultContextCompressors().find((item) => item.id === 'timeline-compression');
    expect(compressor).toBeDefined();

    const input = {
      agentId: 'agent-1',
      messages: [
        {
          id: 'msg-a',
          type: 'conversation' as const,
          content: 'Kickoff completed.',
          metadata: {},
          createdAt: '2025-02-01T00:00:00.000Z',
        },
        {
          id: 'msg-b',
          type: 'conversation' as const,
          content: 'Follow-up action completed.',
          metadata: {},
          createdAt: '2025-02-02T00:00:00.000Z',
        },
      ],
    };

    const artefactA = await compressor!.compress(input, weaveContext());
    const artefactB = await compressor!.compress(input, weaveContext());

    expect(artefactA.summary).toBe(artefactB.summary);
    expect(artefactA.tokensEstimated).toBe(artefactB.tokensEstimated);
  });
});
