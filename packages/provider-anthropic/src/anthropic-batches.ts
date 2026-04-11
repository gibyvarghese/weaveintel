/**
 * @weaveintel/provider-anthropic — Message Batches API
 *
 * Provides full access to the Anthropic Message Batches API for
 * processing large workloads asynchronously at 50% cost:
 * - Create batches of up to 100,000 message requests
 * - List, retrieve, cancel, and delete batches
 * - Stream batch results as JSONL
 */

import type { AnthropicProviderOptions } from './shared.js';
import {
  DEFAULT_BASE_URL,
  resolveApiKey,
  makeHeaders,
  anthropicRequest,
  anthropicGetRequest,
  anthropicDeleteRequest,
} from './shared.js';

// ─── Types ───────────────────────────────────────────────────

export interface BatchMessageRequest {
  custom_id: string;
  params: {
    model: string;
    max_tokens: number;
    messages: Array<{
      role: 'user' | 'assistant';
      content: string | Array<Record<string, unknown>>;
    }>;
    system?: string | Array<Record<string, unknown>>;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    stop_sequences?: string[];
    tools?: Array<Record<string, unknown>>;
    tool_choice?: Record<string, unknown>;
    thinking?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
}

export interface BatchResult {
  custom_id: string;
  result:
    | {
        type: 'succeeded';
        message: {
          id: string;
          type: 'message';
          role: 'assistant';
          content: Array<Record<string, unknown>>;
          model: string;
          stop_reason: string;
          stop_sequence: string | null;
          usage: {
            input_tokens: number;
            output_tokens: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
        };
      }
    | {
        type: 'errored';
        error: { type: string; message: string };
      }
    | {
        type: 'expired';
      }
    | {
        type: 'canceled';
      };
}

export interface MessageBatch {
  id: string;
  type: 'message_batch';
  processing_status: 'in_progress' | 'canceling' | 'ended';
  request_counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  ended_at: string | null;
  created_at: string;
  expires_at: string;
  cancel_initiated_at: string | null;
  results_url: string | null;
}

export interface BatchListResponse {
  data: MessageBatch[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

// ─── Batch operations ────────────────────────────────────────

/**
 * Create a message batch.
 *
 * @example
 * ```ts
 * const batch = await weaveAnthropicCreateBatch([
 *   {
 *     custom_id: 'req-1',
 *     params: {
 *       model: 'claude-sonnet-4-20250514',
 *       max_tokens: 1024,
 *       messages: [{ role: 'user', content: 'Hello!' }],
 *     },
 *   },
 * ]);
 * console.log(batch.id); // "msgbatch_..."
 * ```
 */
export async function weaveAnthropicCreateBatch(
  requests: BatchMessageRequest[],
  options?: AnthropicProviderOptions,
): Promise<MessageBatch> {
  const apiKey = resolveApiKey(options);
  const headers = makeHeaders(options ?? {}, apiKey);
  const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;

  return anthropicRequest(
    baseUrl, '/v1/messages/batches', { requests }, headers,
  ) as Promise<MessageBatch>;
}

/**
 * Retrieve a message batch by ID.
 */
export async function weaveAnthropicGetBatch(
  batchId: string,
  options?: AnthropicProviderOptions,
): Promise<MessageBatch> {
  const apiKey = resolveApiKey(options);
  const headers = makeHeaders(options ?? {}, apiKey);
  const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;

  return anthropicGetRequest(
    baseUrl, `/v1/messages/batches/${encodeURIComponent(batchId)}`, headers,
  ) as Promise<MessageBatch>;
}

/**
 * List message batches with optional pagination.
 */
export async function weaveAnthropicListBatches(
  params?: {
    limit?: number;
    before_id?: string;
    after_id?: string;
  },
  options?: AnthropicProviderOptions,
): Promise<BatchListResponse> {
  const apiKey = resolveApiKey(options);
  const headers = makeHeaders(options ?? {}, apiKey);

  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.before_id) query.set('before_id', params.before_id);
  if (params?.after_id) query.set('after_id', params.after_id);

  const qs = query.toString();
  const path = qs ? `/v1/messages/batches?${qs}` : '/v1/messages/batches';
  const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;

  return anthropicGetRequest(baseUrl, path, headers) as Promise<BatchListResponse>;
}

/**
 * Cancel a message batch (moves to "canceling" status).
 */
export async function weaveAnthropicCancelBatch(
  batchId: string,
  options?: AnthropicProviderOptions,
): Promise<MessageBatch> {
  const apiKey = resolveApiKey(options);
  const headers = makeHeaders(options ?? {}, apiKey);
  const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;

  return anthropicRequest(
    baseUrl, `/v1/messages/batches/${encodeURIComponent(batchId)}/cancel`, {}, headers,
  ) as Promise<MessageBatch>;
}

/**
 * Delete a message batch (only after status is "ended").
 */
export async function weaveAnthropicDeleteBatch(
  batchId: string,
  options?: AnthropicProviderOptions,
): Promise<void> {
  const apiKey = resolveApiKey(options);
  const headers = makeHeaders(options ?? {}, apiKey);
  const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;

  await anthropicDeleteRequest(
    baseUrl, `/v1/messages/batches/${encodeURIComponent(batchId)}`, headers,
  );
}

/**
 * Retrieve batch results as an async generator of BatchResult objects.
 * Results are streamed as JSONL from the Anthropic API.
 */
export async function* weaveAnthropicGetBatchResults(
  batchId: string,
  options?: AnthropicProviderOptions,
): AsyncGenerator<BatchResult> {
  const apiKey = resolveApiKey(options);
  const headers = makeHeaders(options ?? {}, apiKey);
  // Remove content-type for GET request
  const getHeaders = { ...headers };
  delete getHeaders['content-type'];

  const baseUrl = options?.baseUrl ?? 'https://api.anthropic.com';
  const url = `${baseUrl}/v1/messages/batches/${encodeURIComponent(batchId)}/results`;

  const res = await fetch(url, { method: 'GET', headers: getHeaders });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic batch results request failed (${res.status}): ${text}`);
  }

  if (!res.body) {
    throw new Error('No response body for batch results');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        yield JSON.parse(trimmed) as BatchResult;
      }
    }

    // Flush remaining
    if (buffer.trim()) {
      yield JSON.parse(buffer.trim()) as BatchResult;
    }
  } finally {
    reader.releaseLock();
  }
}
