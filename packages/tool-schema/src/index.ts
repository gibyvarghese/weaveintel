/**
 * @weaveintel/tool-schema — public API
 */

export type {
  NormalisedToolCall,
  ProviderToolAdapter,
  SystemPromptLocation,
  ValidationIssue,
} from './types.js';

export { translate, parseToolCall, validate } from './translator.js';
export { translateConversationHistory } from './history.js';
export {
  AdapterRegistry,
  BUILTIN_ADAPTERS,
  defaultAdapterRegistry,
} from './registry.js';

export { openaiAdapter } from './adapters/openai.js';
export { anthropicAdapter } from './adapters/anthropic.js';
export { googleAdapter } from './adapters/google.js';
