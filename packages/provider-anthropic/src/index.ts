// Core chat model (Messages API — chat, tool use, vision, PDF, thinking, caching, citations, streaming)
export {
  weaveAnthropicModel,
  weaveAnthropicConfig,
  weaveAnthropic,
  type AnthropicRequestOptions,
  type AnthropicThinkingConfig,
  type AnthropicContentBlock,
} from './anthropic.js';

export type { AnthropicProviderOptions } from './shared.js';

// Extended thinking helpers
export {
  manualThinking,
  adaptiveThinking,
  disableThinking,
  extractThinkingBlocks,
  extractRawContentBlocks,
  generateWithThinking,
  type ThinkingBlock,
  type RedactedThinkingBlock,
  type ThinkingContentBlock,
} from './anthropic-thinking.js';

// Message Batches API
export {
  weaveAnthropicCreateBatch,
  weaveAnthropicGetBatch,
  weaveAnthropicListBatches,
  weaveAnthropicCancelBatch,
  weaveAnthropicDeleteBatch,
  weaveAnthropicGetBatchResults,
  type BatchMessageRequest,
  type BatchResult,
  type MessageBatch,
  type BatchListResponse,
} from './anthropic-batches.js';

// Computer use tools
export {
  weaveAnthropicComputerTool,
  weaveAnthropicTextEditorTool,
  weaveAnthropicBashTool,
  weaveAnthropicScreenshotResult,
  weaveAnthropicTextResult,
  COMPUTER_USE_BETA,
  type AnthropicComputerTool,
  type AnthropicTextEditorTool,
  type AnthropicBashTool,
  type AnthropicComputerUseTool,
  type ComputerToolResult,
} from './anthropic-computer-use.js';

// Token counting
export {
  weaveAnthropicCountTokens,
  type TokenCountRequest,
  type TokenCountResponse,
} from './anthropic-token-count.js';
