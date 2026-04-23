import { describe, expect, it } from 'vitest';
import { Capabilities } from '@weaveintel/core';
import { weaveOpenAIModel } from './openai.js';

describe('OpenAI model metadata capability mapping', () => {
  it('maps known models with expected capabilities', () => {
    const model = weaveOpenAIModel('gpt-4o-mini', { apiKey: 'test-key' });

    expect(model.hasCapability(Capabilities.Chat)).toBe(true);
    expect(model.hasCapability(Capabilities.Streaming)).toBe(true);
    expect(model.hasCapability(Capabilities.ToolCalling)).toBe(true);
    expect(model.hasCapability(Capabilities.StructuredOutput)).toBe(true);
    expect(model.hasCapability(Capabilities.Vision)).toBe(true);
    expect(model.info.maxContextTokens).toBe(128_000);
  });

  it('fails conservatively for unknown model variants', () => {
    const model = weaveOpenAIModel('future-openai-model-x', { apiKey: 'test-key' });

    expect(model.hasCapability(Capabilities.Chat)).toBe(true);
    expect(model.hasCapability(Capabilities.Streaming)).toBe(true);
    expect(model.hasCapability(Capabilities.ToolCalling)).toBe(false);
    expect(model.hasCapability(Capabilities.StructuredOutput)).toBe(false);
    expect(model.hasCapability(Capabilities.Vision)).toBe(false);
    expect(model.hasCapability(Capabilities.Reasoning)).toBe(false);
    expect(model.info.maxContextTokens).toBe(16_385);
  });
});
