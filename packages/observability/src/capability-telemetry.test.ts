import { describe, expect, it } from 'vitest';
import { weaveContext } from '@weaveintel/core';
import { weaveInMemoryTracer } from './tracer.js';
import {
  annotateSpanWithCapabilityTelemetry,
  capabilityTelemetryToSpanAttributes,
} from './capability-telemetry.js';

describe('capability telemetry helpers', () => {
  it('flattens shared capability summaries into span attributes', () => {
    const attrs = capabilityTelemetryToSpanAttributes({
      kind: 'prompt',
      key: 'support.reply',
      name: 'Support Reply',
      description: 'Detailed support prompt used for customer-facing assistance.',
      version: '1.0',
      strategyKey: 'deliberate',
      renderedCharacters: 128,
      renderedLines: 4,
      durationMs: 9,
      evaluations: [
        { id: 'non_empty', description: 'Prompt output must not be empty.', passed: true, score: 1 },
      ],
    });

    expect(attrs['capability.kind']).toBe('prompt');
    expect(attrs['capability.strategy.key']).toBe('deliberate');
    expect(attrs['capability.evaluations.total']).toBe(1);
  });

  it('annotates spans with shared capability metadata and events', async () => {
    const tracer = weaveInMemoryTracer();
    const ctx = weaveContext({ userId: 'user-1', deadline: Date.now() + 1_000 });

    await tracer.withSpan(ctx, 'test.capability', async (span) => {
      annotateSpanWithCapabilityTelemetry(span, {
        kind: 'skill',
        key: 'skill-summary',
        name: 'Summary Skill',
        description: 'Summarizes long-form source material into concise outputs.',
        source: 'db',
        metadata: { tools: ['text_analysis'] },
      });
    });

    expect(tracer.spans).toHaveLength(1);
    expect(tracer.spans[0]?.attributes['capability.kind']).toBe('skill');
    expect(tracer.spans[0]?.events[0]?.name).toBe('capability.success');
  });
});