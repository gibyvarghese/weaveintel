/**
 * @weaveintel/core — Model contracts
 *
 * Why: Model interfaces define what any LLM provider must implement.
 * We use capability composition, not class hierarchies. A model declares
 * its capabilities and consumers check them at runtime.
 *
 * The contracts split input/output types from the model interface itself,
 * so structured output, streaming, and tool calling are composable features.
 */

import type { CapabilityId, HasCapabilities } from './capabilities.js';
import type { ExecutionContext } from './context.js';

// ─── Content types ───────────────────────────────────────────

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface ImageContent {
  readonly type: 'image';
  readonly url?: string;
  readonly base64?: string;
  readonly mimeType?: string;
}

export interface AudioContent {
  readonly type: 'audio';
  readonly url?: string;
  readonly base64?: string;
  readonly mimeType?: string;
}

export interface FileContent {
  readonly type: 'file';
  readonly url?: string;
  readonly base64?: string;
  readonly mimeType?: string;
  readonly filename?: string;
}

export type ContentPart = TextContent | ImageContent | AudioContent | FileContent;

export interface Message {
  readonly role: Role;
  readonly content: string | ContentPart[];
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ToolCall[];
}

// ─── Tool calling types ──────────────────────────────────────

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly strict?: boolean;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ToolResult {
  readonly toolCallId: string;
  readonly content: string;
  readonly isError?: boolean;
}

// ─── JSON Schema subset ──────────────────────────────────────

export type JsonSchema = {
  readonly type?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly [key: string]: unknown;
};

// ─── Structured output ──────────────────────────────────────

export interface ResponseFormat {
  readonly type: 'json_object' | 'json_schema';
  readonly schema?: JsonSchema;
  readonly name?: string;
  readonly strict?: boolean;
}

// ─── Model request / response ────────────────────────────────

export interface ModelRequest {
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolDefinition[];
  readonly toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  readonly responseFormat?: ResponseFormat;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly topP?: number;
  readonly stop?: readonly string[];
  readonly stream?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface ModelResponse {
  readonly id: string;
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  readonly usage: TokenUsage;
  readonly model: string;
  readonly reasoning?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens?: number;
}

// ─── Streaming ───────────────────────────────────────────────

export interface StreamChunk {
  readonly type: 'text' | 'tool_call' | 'reasoning' | 'usage' | 'done';
  readonly text?: string;
  readonly toolCall?: Partial<ToolCall>;
  readonly reasoning?: string;
  readonly usage?: TokenUsage;
}

export type ModelStream = AsyncIterable<StreamChunk>;

// ─── Model metadata ──────────────────────────────────────────

export interface ModelInfo {
  readonly provider: string;
  readonly modelId: string;
  readonly displayName?: string;
  readonly capabilities: ReadonlySet<CapabilityId>;
  readonly maxContextTokens?: number;
  readonly maxOutputTokens?: number;
  readonly supportedModalities?: readonly string[];
  readonly costPerInputToken?: number;
  readonly costPerOutputToken?: number;
  readonly rateLimitRpm?: number;
  readonly rateLimitTpm?: number;
}

// ─── Model interface ─────────────────────────────────────────

export interface Model extends HasCapabilities {
  readonly info: ModelInfo;

  generate(ctx: ExecutionContext, request: ModelRequest): Promise<ModelResponse>;

  stream?(ctx: ExecutionContext, request: ModelRequest): ModelStream;
}

// ─── Embedding types ─────────────────────────────────────────

export interface EmbeddingRequest {
  readonly input: readonly string[];
  readonly dimensions?: number;
}

export interface EmbeddingResponse {
  readonly embeddings: readonly number[][];
  readonly model: string;
  readonly usage: { readonly totalTokens: number };
}

export interface EmbeddingModel extends HasCapabilities {
  readonly info: ModelInfo;
  embed(ctx: ExecutionContext, request: EmbeddingRequest): Promise<EmbeddingResponse>;
}

// ─── Reranker types ──────────────────────────────────────────

export interface RerankRequest {
  readonly query: string;
  readonly documents: readonly string[];
  readonly topK?: number;
}

export interface RerankResult {
  readonly index: number;
  readonly score: number;
  readonly document: string;
}

export interface RerankResponse {
  readonly results: readonly RerankResult[];
  readonly model: string;
}

export interface RerankerModel extends HasCapabilities {
  readonly info: ModelInfo;
  rerank(ctx: ExecutionContext, request: RerankRequest): Promise<RerankResponse>;
}

// ─── Image generation types ──────────────────────────────────

export interface ImageGenerationRequest {
  readonly prompt: string;
  readonly size?: string;
  readonly quality?: string;
  readonly style?: string;
  readonly n?: number;
}

export interface GeneratedImage {
  readonly url?: string;
  readonly base64?: string;
  readonly revisedPrompt?: string;
}

export interface ImageGenerationResponse {
  readonly images: readonly GeneratedImage[];
  readonly model: string;
}

export interface ImageModel extends HasCapabilities {
  readonly info: ModelInfo;
  generateImage(
    ctx: ExecutionContext,
    request: ImageGenerationRequest,
  ): Promise<ImageGenerationResponse>;
}

// ─── Audio types ─────────────────────────────────────────────

export interface SpeechRequest {
  readonly input: string;
  readonly voice?: string;
  readonly speed?: number;
  readonly responseFormat?: string;
}

export interface TranscriptionRequest {
  readonly audio: Buffer | Uint8Array;
  readonly language?: string;
  readonly prompt?: string;
}

export interface AudioModel extends HasCapabilities {
  readonly info: ModelInfo;
  speak?(ctx: ExecutionContext, request: SpeechRequest): Promise<Buffer>;
  transcribe?(ctx: ExecutionContext, request: TranscriptionRequest): Promise<string>;
}
