/**
 * @weaveintel/provider-openai — OpenAI Responses API adapter
 *
 * Implements the generic ResponseModel contract using OpenAI's Responses API.
 * Supports text generation, built-in tools (web search, file search,
 * code interpreter, image generation, computer use), MCP, function calling,
 * stateful conversations, and streaming.
 */

import type {
  ExecutionContext,
  ResponseModel,
  ResponseRequest,
  ResponseResult,
  ResponseStreamEvent,
  ResponseOutputItem,
  ResponseToolDefinition,
} from '@weaveintel/core';
import { deadlineSignal, normalizeError } from '@weaveintel/core';
import {
  type OpenAIProviderOptions,
  DEFAULT_BASE_URL,
  resolveApiKey,
  makeHeaders,
  openaiRequest,
  openaiStreamRequest,
  openaiGetRequest,
  openaiDeleteRequest,
} from './shared.js';

// ─── Build OpenAI tools payload ──────────────────────────────

function buildResponseTools(tools?: readonly ResponseToolDefinition[]): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => {
    switch (tool.type) {
      case 'function':
        return {
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          ...(tool.strict ? { strict: true } : {}),
        };
      case 'web_search':
        return {
          type: 'web_search_preview',
          ...(tool.searchContextSize ? { search_context_size: tool.searchContextSize } : {}),
          ...(tool.userLocation
            ? { user_location: { type: tool.userLocation.type, city: tool.userLocation.city, region: tool.userLocation.region, country: tool.userLocation.country } }
            : {}),
        };
      case 'file_search':
        return {
          type: 'file_search',
          vector_store_ids: tool.vectorStoreIds,
          ...(tool.maxResults ? { max_num_results: tool.maxResults } : {}),
          ...(tool.rankingOptions ? { ranking_options: { ranker: tool.rankingOptions.ranker, score_threshold: tool.rankingOptions.scoreThreshold } } : {}),
        };
      case 'code_interpreter':
        return {
          type: 'code_interpreter',
          ...(tool.container ? { container: tool.container } : {}),
        };
      case 'image_generation':
        return {
          type: 'image_generation',
          ...(tool.quality ? { quality: tool.quality } : {}),
          ...(tool.size ? { size: tool.size } : {}),
          ...(tool.background ? { background: tool.background } : {}),
          ...(tool.outputFormat ? { output_format: tool.outputFormat } : {}),
        };
      case 'computer_use':
        return {
          type: 'computer_use_preview',
          display_width: tool.displayWidth,
          display_height: tool.displayHeight,
          ...(tool.environment ? { environment: tool.environment } : {}),
        };
      case 'mcp':
        return {
          type: 'mcp',
          server_label: tool.serverLabel,
          server_url: tool.serverUrl,
          ...(tool.allowedTools ? { allowed_tools: tool.allowedTools } : {}),
          ...(tool.headers ? { headers: tool.headers } : {}),
        };
      default:
        return tool;
    }
  });
}

// ─── Parse response output ───────────────────────────────────

function parseOutputItems(items: unknown[]): ResponseOutputItem[] {
  return items.map((item) => {
    const i = item as Record<string, unknown>;
    const type = String(i['type']);

    switch (type) {
      case 'message':
        return {
          type: 'message' as const,
          id: String(i['id']),
          role: 'assistant' as const,
          content: ((i['content'] as unknown[]) ?? []).map((c) => {
            const cc = c as Record<string, unknown>;
            if (cc['type'] === 'output_text') {
              return {
                type: 'output_text' as const,
                text: String(cc['text']),
                annotations: (cc['annotations'] as unknown[])?.map((a) => {
                  const aa = a as Record<string, unknown>;
                  return {
                    type: String(aa['type']) as 'file_citation' | 'url_citation' | 'file_path',
                    fileId: aa['file_id'] as string | undefined,
                    filename: aa['filename'] as string | undefined,
                    url: aa['url'] as string | undefined,
                    title: aa['title'] as string | undefined,
                    index: Number(aa['index'] ?? 0),
                  };
                }),
              };
            }
            return { type: 'refusal' as const, refusal: String(cc['refusal'] ?? '') };
          }),
          status: String(i['status'] ?? 'completed') as 'completed',
        };
      case 'function_call':
        return {
          type: 'function_call' as const,
          id: String(i['id']),
          callId: String(i['call_id']),
          name: String(i['name']),
          arguments: String(i['arguments']),
          status: String(i['status'] ?? 'completed') as 'completed',
        };
      case 'web_search_call':
        return {
          type: 'web_search_call' as const,
          id: String(i['id']),
          status: String(i['status'] ?? 'completed') as 'completed',
        };
      case 'file_search_call':
        return {
          type: 'file_search_call' as const,
          id: String(i['id']),
          status: String(i['status'] ?? 'completed') as 'completed',
          results: (i['results'] as unknown[])?.map((r) => {
            const rr = r as Record<string, unknown>;
            return {
              fileId: String(rr['file_id']),
              filename: String(rr['filename']),
              score: Number(rr['score']),
              text: String(rr['text']),
              attributes: rr['attributes'] as Record<string, unknown> | undefined,
            };
          }),
        };
      case 'code_interpreter_call':
        return {
          type: 'code_interpreter_call' as const,
          id: String(i['id']),
          code: String(i['code'] ?? ''),
          status: String(i['status'] ?? 'completed') as 'completed',
          outputs: (i['outputs'] as unknown[])?.map((o) => {
            const oo = o as Record<string, unknown>;
            if (oo['type'] === 'logs') return { type: 'logs' as const, logs: String(oo['logs']) };
            return { type: 'image' as const, fileId: String(oo['file_id']), mimeType: oo['mime_type'] as string | undefined };
          }),
        };
      case 'image_generation_call':
        return {
          type: 'image_generation_call' as const,
          id: String(i['id']),
          result: i['result'] as string | undefined,
          revisedPrompt: i['revised_prompt'] as string | undefined,
          status: String(i['status'] ?? 'completed') as 'completed',
        };
      case 'reasoning':
        return {
          type: 'reasoning' as const,
          id: String(i['id']),
          summary: (i['summary'] as string[]) ?? undefined,
        };
      case 'computer_call':
        return {
          type: 'computer_use_call' as const,
          id: String(i['id']),
          action: String(i['action'] ?? ''),
          status: String(i['status'] ?? 'completed') as 'completed',
        };
      default:
        return {
          type: 'message' as const,
          id: String(i['id'] ?? ''),
          role: 'assistant' as const,
          content: [{ type: 'output_text' as const, text: JSON.stringify(item) }],
          status: 'completed' as const,
        };
    }
  });
}

function parseResponseResult(raw: Record<string, unknown>): ResponseResult {
  const usage = raw['usage'] as Record<string, unknown> | undefined;
  const inputDetails = usage?.['input_tokens_details'] as Record<string, number> | undefined;
  const outputDetails = usage?.['output_tokens_details'] as Record<string, number> | undefined;

  return {
    id: String(raw['id']),
    status: String(raw['status'] ?? 'completed') as ResponseResult['status'],
    output: parseOutputItems((raw['output'] as unknown[]) ?? []),
    outputText: String(raw['output_text'] ?? ''),
    usage: {
      promptTokens: Number(usage?.['input_tokens'] ?? 0),
      completionTokens: Number(usage?.['output_tokens'] ?? 0),
      totalTokens: Number(usage?.['total_tokens'] ?? 0),
      reasoningTokens: outputDetails?.['reasoning_tokens'],
    },
    model: String(raw['model'] ?? ''),
    error: raw['error']
      ? { code: String((raw['error'] as Record<string, unknown>)['code']), message: String((raw['error'] as Record<string, unknown>)['message']) }
      : undefined,
    previousResponseId: raw['previous_response_id'] as string | undefined,
    metadata: raw['metadata'] as Record<string, unknown> | undefined,
  };
}

// ─── OpenAI Responses API adapter ────────────────────────────

export function weaveOpenAIResponseModel(
  providerOptions?: OpenAIProviderOptions,
): ResponseModel {
  const opts = providerOptions ?? {};
  const apiKey = resolveApiKey(opts);
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const headers = makeHeaders(opts, apiKey);

  return {
    async createResponse(ctx: ExecutionContext, request: ResponseRequest): Promise<ResponseResult> {
      const body: Record<string, unknown> = {
        model: request.model,
        input: request.input,
      };
      if (request.instructions) body['instructions'] = request.instructions;
      if (request.tools) body['tools'] = buildResponseTools(request.tools);
      if (request.toolChoice) {
        body['tool_choice'] =
          typeof request.toolChoice === 'string'
            ? request.toolChoice
            : { type: request.toolChoice.type, ...(request.toolChoice.name ? { name: request.toolChoice.name } : {}) };
      }
      if (request.temperature != null) body['temperature'] = request.temperature;
      if (request.maxOutputTokens != null) body['max_output_tokens'] = request.maxOutputTokens;
      if (request.topP != null) body['top_p'] = request.topP;
      if (request.parallelToolCalls != null) body['parallel_tool_calls'] = request.parallelToolCalls;
      if (request.previousResponseId) body['previous_response_id'] = request.previousResponseId;
      if (request.conversationId) body['conversation'] = request.conversationId;
      if (request.store != null) body['store'] = request.store;
      if (request.responseFormat) {
        if (request.responseFormat.type === 'json_schema') {
          body['text'] = { format: { type: 'json_schema', name: request.responseFormat.name, schema: request.responseFormat.schema, strict: request.responseFormat.strict } };
        } else {
          body['text'] = { format: { type: request.responseFormat.type } };
        }
      }
      if (request.reasoning) body['reasoning'] = { effort: request.reasoning.effort, summary: request.reasoning.summary };
      if (request.truncation) body['truncation'] = request.truncation;
      if (request.metadata) body['metadata'] = request.metadata;

      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiRequest(baseUrl, '/responses', body, headers, signal)) as Record<string, unknown>;
        return parseResponseResult(raw);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    streamResponse(ctx: ExecutionContext, request: ResponseRequest): AsyncIterable<ResponseStreamEvent> {
      const body: Record<string, unknown> = {
        model: request.model,
        input: request.input,
        stream: true,
      };
      if (request.instructions) body['instructions'] = request.instructions;
      if (request.tools) body['tools'] = buildResponseTools(request.tools);
      if (request.toolChoice) {
        body['tool_choice'] =
          typeof request.toolChoice === 'string'
            ? request.toolChoice
            : { type: request.toolChoice.type, ...(request.toolChoice.name ? { name: request.toolChoice.name } : {}) };
      }
      if (request.temperature != null) body['temperature'] = request.temperature;
      if (request.maxOutputTokens != null) body['max_output_tokens'] = request.maxOutputTokens;
      if (request.previousResponseId) body['previous_response_id'] = request.previousResponseId;
      if (request.conversationId) body['conversation'] = request.conversationId;
      if (request.reasoning) body['reasoning'] = { effort: request.reasoning.effort, summary: request.reasoning.summary };
      if (request.metadata) body['metadata'] = request.metadata;

      const signal = deadlineSignal(ctx);

      return (async function* (): AsyncIterable<ResponseStreamEvent> {
        for await (const chunk of openaiStreamRequest(baseUrl, '/responses', body, headers, signal)) {
          const c = chunk as Record<string, unknown>;
          const eventType = String(c['type'] ?? '');

          switch (eventType) {
            case 'response.created':
            case 'response.in_progress':
            case 'response.completed':
            case 'response.failed':
              yield { type: eventType as 'response.completed', response: parseResponseResult(c['response'] as Record<string, unknown>) };
              break;
            case 'response.output_item.added':
            case 'response.output_item.done':
              yield { type: eventType as 'response.output_item.added', item: parseOutputItems([c['item']])[0]! };
              break;
            case 'response.content_part.delta':
            case 'response.output_text.delta': {
              const delta = (c['delta'] as Record<string, unknown>)?.['text'] ?? c['delta'] ?? '';
              yield { type: 'response.output_text.delta', delta: String(delta) };
              break;
            }
            case 'response.output_text.done':
              yield { type: 'response.output_text.done', text: String(c['text'] ?? '') };
              break;
            case 'response.function_call_arguments.delta':
              yield { type: 'response.function_call_arguments.delta', delta: String(c['delta'] ?? '') };
              break;
            case 'response.function_call_arguments.done':
              yield { type: 'response.function_call_arguments.done', arguments: String(c['arguments'] ?? '') };
              break;
            case 'response.code_interpreter_call.code.delta':
              yield { type: 'response.code_interpreter.code.delta', delta: String(c['delta'] ?? '') };
              break;
            case 'response.web_search_call.searching':
              yield { type: 'response.web_search.searching' };
              break;
            case 'response.file_search_call.searching':
              yield { type: 'response.file_search.searching' };
              break;
            case 'response.image_generation_call.partial_image':
              yield {
                type: 'response.image_generation.partial_image',
                partialImageB64: String(c['partial_image_b64'] ?? ''),
                partialImageIndex: Number(c['partial_image_index'] ?? 0),
              };
              break;
            case 'response.reasoning.delta':
              yield { type: 'response.reasoning.delta', delta: String(c['delta'] ?? '') };
              break;
            case 'error':
              yield {
                type: 'response.error',
                error: { code: String((c['error'] as Record<string, unknown>)?.['code'] ?? 'unknown'), message: String((c['error'] as Record<string, unknown>)?.['message'] ?? '') },
              };
              break;
            // Skip other event types we don't need to expose
          }
        }
      })();
    },

    async retrieveResponse(ctx: ExecutionContext, responseId: string): Promise<ResponseResult> {
      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiGetRequest(baseUrl, `/responses/${encodeURIComponent(responseId)}`, headers, signal)) as Record<string, unknown>;
        return parseResponseResult(raw);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async deleteResponse(ctx: ExecutionContext, responseId: string): Promise<void> {
      const signal = deadlineSignal(ctx);
      try {
        await openaiDeleteRequest(baseUrl, `/responses/${encodeURIComponent(responseId)}`, headers, signal);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async cancelResponse(ctx: ExecutionContext, responseId: string): Promise<ResponseResult> {
      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiRequest(baseUrl, `/responses/${encodeURIComponent(responseId)}/cancel`, {}, headers, signal)) as Record<string, unknown>;
        return parseResponseResult(raw);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },
  };
}

/** Convenience function */
export function weaveOpenAIResponses(options?: OpenAIProviderOptions): ResponseModel {
  return weaveOpenAIResponseModel(options);
}
