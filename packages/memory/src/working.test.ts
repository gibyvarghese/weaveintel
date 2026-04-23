import { describe, expect, it } from 'vitest';
import { weaveContext } from '@weaveintel/core';
import { createNoopCompressor, weaveWorkingMemory } from './working.js';

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
});
