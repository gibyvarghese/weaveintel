/**
 * @weaveintel/core — Responses API contracts (generic agentic loop)
 *
 * Why: Modern LLM APIs are moving to a unified "response" model that
 * combines text generation, tool calling, and built-in tools (web search,
 * file search, code execution, image generation) in a single agentic loop.
 * This contract is provider-agnostic so it works with OpenAI's Responses API,
 * Anthropic's tool_use, Google's Gemini, etc.
 */

import type { ExecutionContext } from './context.js';
import type { ContentPart, TokenUsage, JsonSchema } from './models.js';

// ─── Response input types ────────────────────────────────────

export type ResponseInputItem =
  | ResponseInputMessage
  | ResponseFunctionCallOutput
  | ResponseItemReference;

export interface ResponseInputMessage {
  readonly type: 'message';
  readonly role: 'user' | 'system' | 'developer';
  readonly content: string | ContentPart[];
}

export interface ResponseFunctionCallOutput {
  readonly type: 'function_call_output';
  readonly callId: string;
  readonly output: string;
}

export interface ResponseItemReference {
  readonly type: 'item_reference';
  readonly id: string;
}

// ─── Response output types ───────────────────────────────────

export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseFunctionCall
  | ResponseWebSearchCall
  | ResponseFileSearchCall
  | ResponseCodeInterpreterCall
  | ResponseImageGenerationCall
  | ResponseReasoningItem
  | ResponseComputerUseCall;

export interface ResponseOutputMessage {
  readonly type: 'message';
  readonly id: string;
  readonly role: 'assistant';
  readonly content: ResponseOutputContent[];
  readonly status: 'in_progress' | 'completed' | 'incomplete';
}

export type ResponseOutputContent =
  | { readonly type: 'output_text'; readonly text: string; readonly annotations?: ResponseAnnotation[] }
  | { readonly type: 'refusal'; readonly refusal: string };

export interface ResponseAnnotation {
  readonly type: 'file_citation' | 'url_citation' | 'file_path';
  readonly fileId?: string;
  readonly filename?: string;
  readonly url?: string;
  readonly title?: string;
  readonly index: number;
}

export interface ResponseFunctionCall {
  readonly type: 'function_call';
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
  readonly status: 'in_progress' | 'completed' | 'failed';
}

export interface ResponseWebSearchCall {
  readonly type: 'web_search_call';
  readonly id: string;
  readonly status: 'completed' | 'searching' | 'failed';
}

export interface ResponseFileSearchCall {
  readonly type: 'file_search_call';
  readonly id: string;
  readonly status: 'completed' | 'searching' | 'failed';
  readonly results?: ResponseFileSearchResult[];
}

export interface ResponseFileSearchResult {
  readonly fileId: string;
  readonly filename: string;
  readonly score: number;
  readonly text: string;
  readonly attributes?: Record<string, unknown>;
}

export interface ResponseCodeInterpreterCall {
  readonly type: 'code_interpreter_call';
  readonly id: string;
  readonly code: string;
  readonly status: 'completed' | 'running' | 'failed';
  readonly outputs?: ResponseCodeOutput[];
}

export type ResponseCodeOutput =
  | { readonly type: 'logs'; readonly logs: string }
  | { readonly type: 'image'; readonly fileId: string; readonly mimeType?: string };

export interface ResponseImageGenerationCall {
  readonly type: 'image_generation_call';
  readonly id: string;
  readonly result?: string; // base64 image data
  readonly revisedPrompt?: string;
  readonly status: 'completed' | 'generating' | 'failed';
}

export interface ResponseReasoningItem {
  readonly type: 'reasoning';
  readonly id: string;
  readonly summary?: string[];
}

export interface ResponseComputerUseCall {
  readonly type: 'computer_use_call';
  readonly id: string;
  readonly action: string;
  readonly status: 'completed' | 'running' | 'failed';
}

// ─── Tool definitions (built-in + custom) ────────────────────

export type ResponseToolDefinition =
  | ResponseFunctionTool
  | ResponseWebSearchTool
  | ResponseFileSearchTool
  | ResponseCodeInterpreterTool
  | ResponseImageGenerationTool
  | ResponseComputerUseTool
  | ResponseMCPTool;

export interface ResponseFunctionTool {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly strict?: boolean;
}

export interface ResponseWebSearchTool {
  readonly type: 'web_search';
  readonly searchContextSize?: 'low' | 'medium' | 'high';
  readonly userLocation?: { readonly type: 'approximate'; readonly city?: string; readonly region?: string; readonly country?: string };
}

export interface ResponseFileSearchTool {
  readonly type: 'file_search';
  readonly vectorStoreIds: string[];
  readonly maxResults?: number;
  readonly rankingOptions?: {
    readonly ranker?: string;
    readonly scoreThreshold?: number;
  };
}

export interface ResponseCodeInterpreterTool {
  readonly type: 'code_interpreter';
  readonly container?: { readonly id: string } | { readonly type: string; readonly fileIds?: string[] };
}

export interface ResponseImageGenerationTool {
  readonly type: 'image_generation';
  readonly quality?: 'low' | 'medium' | 'high' | 'auto';
  readonly size?: string;
  readonly background?: 'transparent' | 'opaque' | 'auto';
  readonly outputFormat?: 'png' | 'jpeg' | 'webp';
}

export interface ResponseComputerUseTool {
  readonly type: 'computer_use';
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly environment?: string;
}

export interface ResponseMCPTool {
  readonly type: 'mcp';
  readonly serverLabel: string;
  readonly serverUrl: string;
  readonly allowedTools?: string[];
  readonly headers?: Record<string, string>;
}

// ─── Response request / response ─────────────────────────────

export interface ResponseRequest {
  readonly model: string;
  readonly input: string | ResponseInputItem[];
  readonly instructions?: string;
  readonly tools?: readonly ResponseToolDefinition[];
  readonly toolChoice?: 'auto' | 'none' | 'required' | { readonly type: string; readonly name?: string };
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly topP?: number;
  readonly parallelToolCalls?: boolean;
  readonly previousResponseId?: string;
  readonly conversationId?: string;
  readonly store?: boolean;
  readonly stream?: boolean;
  readonly responseFormat?: ResponseTextFormat;
  readonly reasoning?: { readonly effort?: 'none' | 'low' | 'medium' | 'high'; readonly summary?: 'auto' | 'concise' | 'detailed' };
  readonly truncation?: 'auto' | 'disabled';
  readonly metadata?: Record<string, unknown>;
}

export type ResponseTextFormat =
  | { readonly type: 'text' }
  | { readonly type: 'json_object' }
  | { readonly type: 'json_schema'; readonly name: string; readonly schema: JsonSchema; readonly strict?: boolean };

export interface ResponseResult {
  readonly id: string;
  readonly status: 'completed' | 'failed' | 'incomplete' | 'cancelled';
  readonly output: readonly ResponseOutputItem[];
  readonly outputText: string;
  readonly usage: TokenUsage;
  readonly model: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly previousResponseId?: string;
  readonly metadata?: Record<string, unknown>;
}

// ─── Streaming events ────────────────────────────────────────

export type ResponseStreamEvent =
  | { readonly type: 'response.created'; readonly response: ResponseResult }
  | { readonly type: 'response.in_progress'; readonly response: ResponseResult }
  | { readonly type: 'response.completed'; readonly response: ResponseResult }
  | { readonly type: 'response.failed'; readonly response: ResponseResult }
  | { readonly type: 'response.output_item.added'; readonly item: ResponseOutputItem }
  | { readonly type: 'response.output_item.done'; readonly item: ResponseOutputItem }
  | { readonly type: 'response.output_text.delta'; readonly delta: string }
  | { readonly type: 'response.output_text.done'; readonly text: string }
  | { readonly type: 'response.function_call_arguments.delta'; readonly delta: string }
  | { readonly type: 'response.function_call_arguments.done'; readonly arguments: string }
  | { readonly type: 'response.code_interpreter.code.delta'; readonly delta: string }
  | { readonly type: 'response.web_search.searching' }
  | { readonly type: 'response.file_search.searching' }
  | { readonly type: 'response.image_generation.partial_image'; readonly partialImageB64: string; readonly partialImageIndex: number }
  | { readonly type: 'response.reasoning.delta'; readonly delta: string }
  | { readonly type: 'response.error'; readonly error: { readonly code: string; readonly message: string } };

// ─── Response model interface ────────────────────────────────

export interface ResponseModel {
  createResponse(ctx: ExecutionContext, request: ResponseRequest): Promise<ResponseResult>;
  streamResponse?(ctx: ExecutionContext, request: ResponseRequest): AsyncIterable<ResponseStreamEvent>;
  retrieveResponse?(ctx: ExecutionContext, responseId: string): Promise<ResponseResult>;
  deleteResponse?(ctx: ExecutionContext, responseId: string): Promise<void>;
  cancelResponse?(ctx: ExecutionContext, responseId: string): Promise<ResponseResult>;
}
