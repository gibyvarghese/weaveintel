import type { CapabilityId } from '@weaveintel/core';
import { Capabilities } from '@weaveintel/core';

export interface AnthropicModelMetadata {
  pattern: RegExp;
  capabilities: CapabilityId[];
  contextWindow: number;
  maxOutputTokens: number;
}

export const ANTHROPIC_MODEL_METADATA: AnthropicModelMetadata[] = [
  {
    pattern: /mythos/i,
    capabilities: [
      Capabilities.Chat,
      Capabilities.Streaming,
      Capabilities.ToolCalling,
      Capabilities.Vision,
      Capabilities.Multimodal,
      Capabilities.StructuredOutput,
      Capabilities.Reasoning,
      Capabilities.ComputerUse,
    ],
    contextWindow: 1_048_576,
    maxOutputTokens: 128_000,
  },
  {
    pattern: /(opus-4-6|opus-4-5)/i,
    capabilities: [
      Capabilities.Chat,
      Capabilities.Streaming,
      Capabilities.ToolCalling,
      Capabilities.Vision,
      Capabilities.Multimodal,
      Capabilities.StructuredOutput,
      Capabilities.Reasoning,
      Capabilities.ComputerUse,
    ],
    contextWindow: 200_000,
    maxOutputTokens: 128_000,
  },
  {
    pattern: /sonnet-4-6/i,
    capabilities: [
      Capabilities.Chat,
      Capabilities.Streaming,
      Capabilities.ToolCalling,
      Capabilities.Vision,
      Capabilities.Multimodal,
      Capabilities.StructuredOutput,
      Capabilities.Reasoning,
      Capabilities.ComputerUse,
    ],
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
  },
  {
    pattern: /haiku-4-5/i,
    capabilities: [
      Capabilities.Chat,
      Capabilities.Streaming,
      Capabilities.ToolCalling,
      Capabilities.Vision,
      Capabilities.Multimodal,
      Capabilities.StructuredOutput,
      Capabilities.Reasoning,
    ],
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
  },
  {
    pattern: /(claude-4|claude-opus|claude-sonnet|claude-haiku|claude-3)/i,
    capabilities: [
      Capabilities.Chat,
      Capabilities.Streaming,
      Capabilities.ToolCalling,
      Capabilities.Vision,
      Capabilities.Multimodal,
      Capabilities.StructuredOutput,
      Capabilities.Reasoning,
    ],
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
  },
];

export const ANTHROPIC_DEFAULT_METADATA: AnthropicModelMetadata = {
  pattern: /.*/,
  capabilities: [Capabilities.Chat, Capabilities.Streaming],
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
};

export function resolveAnthropicModelMetadata(modelId: string): AnthropicModelMetadata {
  return ANTHROPIC_MODEL_METADATA.find(m => m.pattern.test(modelId)) ?? ANTHROPIC_DEFAULT_METADATA;
}

export function determineCapabilities(modelId: string): CapabilityId[] {
  return [...resolveAnthropicModelMetadata(modelId).capabilities];
}

export function getContextWindow(modelId: string): number {
  return resolveAnthropicModelMetadata(modelId).contextWindow;
}

export function getMaxOutputTokens(modelId: string): number {
  return resolveAnthropicModelMetadata(modelId).maxOutputTokens;
}
