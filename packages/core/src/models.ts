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
  /**
   * Provider-native prompt caching hint. When set, the provider caches the
   * stable prefix (tools + system) so repeated requests sharing that prefix pay
   * the discounted cache-read rate (~90% off input on Anthropic).
   *
   * - Anthropic: applies an explicit `cache_control: ephemeral` breakpoint to
   *   the system block (covering tools + system in render order).
   * - OpenAI / Gemini: caching is automatic/implicit, so this is a no-op hint —
   *   the benefit comes from a stable, static-first prefix.
   *
   * `ttl` selects the cache lifetime where the provider supports it
   * (`'5m'` default, `'1h'` extended).
   */
  readonly promptCache?: { readonly ttl?: '5m' | '1h' };
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
  /**
   * Input tokens served from the provider's prompt cache at the discounted
   * read rate (Anthropic `cache_read_input_tokens`, OpenAI
   * `prompt_tokens_details.cached_tokens`, Gemini `cachedContentTokenCount`).
   * Present and > 0 indicates a prompt-cache hit. Included within `promptTokens`.
   */
  readonly cacheReadTokens?: number;
  /**
   * Input tokens written to the provider's prompt cache at the write rate on a
   * cache miss (Anthropic `cache_creation_input_tokens`). Included within
   * `promptTokens`.
   */
  readonly cacheWriteTokens?: number;
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
  /** e.g. '1024x1024' | '1536x1024' | '1024x1536' | 'auto' (GPT Image); '1024x1792' etc. (DALL·E 3). */
  readonly size?: string;
  /** GPT Image: 'low' | 'medium' | 'high' | 'auto'. DALL·E 3: 'standard' | 'hd'. */
  readonly quality?: string;
  /** DALL·E 3 only: 'vivid' | 'natural'. (GPT Image ignores this.) */
  readonly style?: string;
  readonly n?: number;
  /** GPT Image only: 'transparent' | 'opaque' | 'auto'. */
  readonly background?: string;
  /** GPT Image only: returned image format 'png' | 'jpeg' | 'webp' (default png). */
  readonly outputFormat?: string;
  /** GPT Image only: 0-100 compression level for 'jpeg'/'webp' output. */
  readonly outputCompression?: number;
  /** GPT Image only: content-moderation strictness 'low' | 'auto'. */
  readonly moderation?: string;
}

export interface GeneratedImage {
  readonly url?: string;
  readonly base64?: string;
  readonly revisedPrompt?: string;
}

export interface ImageGenerationResponse {
  readonly images: readonly GeneratedImage[];
  readonly model: string;
  /** Token usage (GPT Image models report this; DALL·E does not). */
  readonly usage?: Readonly<Record<string, unknown>>;
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
  /** Optional cancellation signal (Phase 7: chained pipeline barge-in). */
  readonly signal?: AbortSignal;
}

export interface TranscriptionRequest {
  readonly audio: Buffer | Uint8Array;
  readonly language?: string;
  readonly prompt?: string;
  /** Optional model override (e.g. 'whisper-1', 'gpt-4o-transcribe'). Provider default when omitted. */
  readonly model?: string;
  /** MIME type / container hint for the audio bytes (e.g. 'audio/webm', 'audio/wav', 'audio/mp3'). */
  readonly mimeType?: string;
  /** Request timestamped segments (verbose transcription). Used by `transcribeDetailed`. */
  readonly segments?: boolean;
}

/** One timestamped chunk of a transcript (seconds from the start of the audio). */
export interface TranscriptSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Optional speaker label when diarization is available. */
  readonly speaker?: string;
}

/** A rich transcription result: the full text plus timestamped segments + metadata. */
export interface TranscriptionResult {
  readonly text: string;
  readonly language?: string;
  /** Total audio duration in seconds, when the provider reports it. */
  readonly duration?: number;
  readonly segments: TranscriptSegment[];
}

export interface AudioModel extends HasCapabilities {
  readonly info: ModelInfo;
  speak?(ctx: ExecutionContext, request: SpeechRequest): Promise<Buffer>;
  /**
   * Streaming TTS — yields audio chunks as the provider generates them.
   * Callers should begin playback on the first chunk rather than waiting
   * for the full buffer.  Falls back to `speak()` if not implemented.
   */
  speakStream?(ctx: ExecutionContext, request: SpeechRequest): AsyncIterable<Buffer>;
  transcribe?(ctx: ExecutionContext, request: TranscriptionRequest): Promise<string>;
  /**
   * Rich transcription: returns the text PLUS timestamped segments (and language/duration when
   * available). Enables transcript-anchored features (meeting notes with clickable citations).
   * Optional — callers should fall back to `transcribe()` (text-only) when a provider lacks it.
   */
  transcribeDetailed?(ctx: ExecutionContext, request: TranscriptionRequest): Promise<TranscriptionResult>;
}
