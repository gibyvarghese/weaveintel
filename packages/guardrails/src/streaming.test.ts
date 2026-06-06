/**
 * @weaveintel/guardrails — streaming.test.ts  (W5)
 */
import { describe, it, expect } from 'vitest';
import type { Guardrail } from '@weaveintel/core';
import { createStreamingGuardrail } from './streaming.js';

const blocklistGuardrail = (words: string[]): Guardrail => ({
  id: 'stream-bl',
  name: 'Stream blocklist',
  type: 'blocklist',
  stage: 'post-execution',
  enabled: true,
  config: { words, action: 'deny' },
});

describe('createStreamingGuardrail', () => {
  it('passes clean chunks through', () => {
    const guard = createStreamingGuardrail({
      guardrails: [blocklistGuardrail(['badword'])],
      minBufferSize: 0,
    });
    expect(guard.checkChunk('hello ').halt).toBe(false);
    expect(guard.checkChunk('world').halt).toBe(false);
    expect(guard.flush().halt).toBe(false);
  });

  it('halts when a blocked word appears in accumulated buffer', () => {
    const guard = createStreamingGuardrail({
      guardrails: [blocklistGuardrail(['classified'])],
      minBufferSize: 0,
    });
    guard.checkChunk('Here is some ');
    const result = guard.checkChunk('classified information.');
    expect(result.halt).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it('halts on flush when buffer contains blocked content', () => {
    const guard = createStreamingGuardrail({
      guardrails: [blocklistGuardrail(['secret'])],
      minBufferSize: 1000, // will not check until flush
    });
    guard.checkChunk('this is a secret');
    const result = guard.flush();
    expect(result.halt).toBe(true);
  });

  it('continues returning halt after first denial', () => {
    const guard = createStreamingGuardrail({
      guardrails: [blocklistGuardrail(['bad'])],
      minBufferSize: 0,
    });
    guard.checkChunk('bad content');
    expect(guard.checkChunk(' more text').halt).toBe(true);
    expect(guard.flush().halt).toBe(true);
  });

  it('accumulates the buffer correctly', () => {
    const guard = createStreamingGuardrail({ guardrails: [] });
    guard.checkChunk('hello ');
    guard.checkChunk('world');
    expect(guard.buffer).toBe('hello world');
  });

  it('ignores model-graded guardrails (only sync types run)', () => {
    const modelGraded: Guardrail = {
      id: 'mg', name: 'Model', type: 'model-graded',
      stage: 'post-execution', enabled: true, config: { rule: 'llm-judge' },
    };
    const guard = createStreamingGuardrail({
      guardrails: [modelGraded],
      minBufferSize: 0,
    });
    // Should not halt — model-graded is filtered out
    expect(guard.checkChunk('any content').halt).toBe(false);
  });

  it('does not check until minBufferSize is reached', () => {
    const guard = createStreamingGuardrail({
      guardrails: [blocklistGuardrail(['bad'])],
      minBufferSize: 20,
    });
    // "bad" is 3 chars — below the 20-char threshold
    const r = guard.checkChunk('bad');
    expect(r.halt).toBe(false);
    // Flush forces evaluation
    expect(guard.flush().halt).toBe(true);
  });
});
