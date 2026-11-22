// SPDX-License-Identifier: MIT
/**
 * @weaveintel/provider-registry — model providers as data.
 *
 * In plain terms: describe a provider (which wire format, where it lives, the
 * NAMES of its keys) as a small record, and this package turns that record
 * into a working chat or embedding model. Keys are fetched when a call is
 * made, never stored on the model, and never appear in an error or an event.
 * A host application can therefore let an administrator add a provider on a
 * screen and use it straight away, with no code change and no restart.
 */

export { createProviderRegistry, type ProviderRegistry, type ProviderRegistryOptions, type PrivateEndpointSource, type AdapterSummary } from './registry.js';

export type {
  WireQuirks,
  ProviderDescription,
  EmbeddingModelDescriptor,
  EmbeddingMode,
  ModelDescription,
  DiscoveredModel,
  PrivateEndpointAllowance,
  WireRequest,
  WireResponse,
  WireStream,
  ProviderTransport,
  DerivedTokenCache,
  AdapterCall,
  AdapterEmbedInput,
  AdapterEmbedOutput,
  SecretSlot,
  ProviderAdapter,
  WireErrorOverride,
  EmbeddingProvenance,
  DescribedEmbeddingRequest,
  DescribedEmbeddingResponse,
  DescribedEmbeddingModel,
  ConnectionTestResult,
  RegistryEvent,
} from './types.js';

// Adapters
export { openAICompatibleAdapter, toOpenAIMessages, type OpenAICompatibleAdapterOptions } from './adapters/openai-compatible.js';
export { OPENAI_COMPATIBLE_PRESETS, azureOpenAIAdapter, azureFoundryAdapter, databricksAdapter, type OpenAICompatiblePreset } from './adapters/presets.js';
export { bedrockAdapter, bedrockErrorOverride, toConverseMessages } from './adapters/bedrock/bedrock.js';
export { wrappedFactoryAdapter, type WrappedFactoryAdapterOptions, type WrappedFactoryCredentials } from './adapters/wrapped.js';

// Building blocks for adapters that live in other packages
export { httpFailure, parseJsonBody, malformed, providerMessage, retryAfterFrom, sseData } from './wire.js';
export { normalizeVector, isUnitLength, truncateVector } from './vectors.js';
export { signRequest, awsEncode, type AwsCredentials, type SignInput } from './adapters/bedrock/sigv4.js';
export { readEventStream, encodeEventStreamMessage, crc32, EventStreamFormatError, type EventStreamMessage } from './adapters/bedrock/event-stream.js';

// Capability profile of a model row (what it can read and do)
export { profileOfModel } from './profile.js';
export { BEDROCK_DOCUMENT_FORMATS, BEDROCK_AUDIO_FORMATS } from './adapters/bedrock/bedrock.js';
