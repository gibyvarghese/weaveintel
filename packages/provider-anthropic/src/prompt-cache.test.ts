/**
 * @weaveintel/provider-anthropic — Phase 2 prompt-cache wiring tests.
 *
 * Pure-function coverage of the cache_control breakpoint placement and the
 * cache-token surfacing (the only correct, effective placement is on a content
 * block — a top-level cache_control is ignored by the Anthropic API).
 */
import { describe, it, expect } from 'vitest';
import { applySystemCacheControl, parseResponse, parseStreamEvent } from '../src/anthropic-format.js';
import type { AnthropicContentBlock } from '../src/anthropic-types.js';

describe('applySystemCacheControl', () => {
  it('wraps a string system prompt into a cache-controlled block', () => {
    const out = applySystemCacheControl('You are a helpful assistant.', '5m');
    expect(Array.isArray(out)).toBe(true);
    const blocks = out as AnthropicContentBlock[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[0]!.text).toBe('You are a helpful assistant.');
    expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('uses the 1h TTL when requested', () => {
    const blocks = applySystemCacheControl('sys', '1h') as AnthropicContentBlock[];
    expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('marks the LAST block of an existing block array', () => {
    const input: AnthropicContentBlock[] = [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ];
    const out = applySystemCacheControl(input, '5m') as AnthropicContentBlock[];
    expect(out[0]!.cache_control).toBeUndefined();
    expect(out[1]!.cache_control).toEqual({ type: 'ephemeral' });
    // Does not mutate the input.
    expect(input[1]!.cache_control).toBeUndefined();
  });

  it('leaves undefined / empty system unchanged', () => {
    expect(applySystemCacheControl(undefined, '5m')).toBeUndefined();
    expect(applySystemCacheControl('', '5m')).toBe('');
  });
});

describe('parseResponse — cache token surfacing', () => {
  it('surfaces cache_read / cache_creation tokens in usage', () => {
    const res = parseResponse({
      id: 'msg_1', model: 'claude-x', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2048, cache_creation_input_tokens: 0 },
    });
    expect(res.usage.cacheReadTokens).toBe(2048);
    expect(res.usage.cacheWriteTokens).toBe(0);
    // promptTokens includes cached input.
    expect(res.usage.promptTokens).toBe(10 + 2048);
  });

  it('reports cache_creation on a cold write', () => {
    const res = parseResponse({
      id: 'msg_2', model: 'claude-x', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 2048 },
    });
    expect(res.usage.cacheWriteTokens).toBe(2048);
    expect(res.usage.cacheReadTokens).toBe(0);
  });
});

describe('parseStreamEvent — message_start cache tokens', () => {
  it('emits a usage chunk carrying cache read/write tokens', () => {
    const chunks = [...parseStreamEvent({
      event: 'message_start',
      data: { type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 } } },
    } as any)];
    const usage = chunks.find((c) => c.type === 'usage');
    expect(usage?.usage?.cacheReadTokens).toBe(1500);
    expect(usage?.usage?.promptTokens).toBe(12 + 1500);
  });
});
