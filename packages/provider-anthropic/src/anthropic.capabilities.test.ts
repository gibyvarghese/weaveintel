import { describe, expect, it } from 'vitest';
import { Capabilities } from '@weaveintel/core';
import { weaveAnthropicModel } from './anthropic.js';

describe('Anthropic model metadata capability mapping', () => {
  it('maps known models with expected capabilities', () => {
    const model = weaveAnthropicModel('claude-sonnet-4-6', { apiKey: 'test-key' });

    expect(model.hasCapability(Capabilities.Chat)).toBe(true);
    expect(model.hasCapability(Capabilities.Streaming)).toBe(true);
    expect(model.hasCapability(Capabilities.ToolCalling)).toBe(true);
    expect(model.hasCapability(Capabilities.StructuredOutput)).toBe(true);
    expect(model.hasCapability(Capabilities.Vision)).toBe(true);
    expect(model.hasCapability(Capabilities.Reasoning)).toBe(true);
    expect(model.info.maxContextTokens).toBe(200_000);
  });

  it('fails conservatively for unknown model variants', () => {
    const model = weaveAnthropicModel('future-claude-experimental', { apiKey: 'test-key' });

    expect(model.hasCapability(Capabilities.Chat)).toBe(true);
    expect(model.hasCapability(Capabilities.Streaming)).toBe(true);
    expect(model.hasCapability(Capabilities.ToolCalling)).toBe(false);
    expect(model.hasCapability(Capabilities.StructuredOutput)).toBe(false);
    expect(model.hasCapability(Capabilities.Vision)).toBe(false);
    expect(model.hasCapability(Capabilities.Reasoning)).toBe(false);
  });
});
