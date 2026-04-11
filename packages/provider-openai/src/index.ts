export {
  weaveOpenAIModel,
  weaveOpenAIEmbeddingModel,
  weaveOpenAIConfig,
  weaveOpenAI,
  weaveOpenAIEmbedding,
  type OpenAIProviderOptions,
} from './openai.js';

// Responses API (agentic loop with built-in tools)
export {
  weaveOpenAIResponseModel,
  weaveOpenAIResponses,
} from './openai-responses.js';

// Image generation & editing
export {
  weaveOpenAIImageModel,
  weaveOpenAIImage,
} from './openai-images.js';

// Audio — TTS & STT
export {
  weaveOpenAIAudioModel,
  weaveOpenAIAudio,
} from './openai-audio.js';

// Managed vector stores
export {
  weaveOpenAIVectorStoreClient,
  weaveOpenAIVectorStore,
} from './openai-vectorstores.js';

// File storage
export {
  weaveOpenAIFileStorage,
  weaveOpenAIFiles,
} from './openai-files.js';

// Content moderation
export {
  weaveOpenAIModerationModel,
  weaveOpenAIModeration,
} from './openai-moderation.js';

// Fine-tuning
export {
  weaveOpenAIFineTuningProvider,
  weaveOpenAIFineTuning,
} from './openai-finetuning.js';
