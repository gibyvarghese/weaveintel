/**
 * @weaveintel/a2a — JSON-RPC 2.0 codec
 *
 * Typed codec for A2A v1.0 JSON-RPC 2.0 wire format.
 * All A2A communication flows through a single HTTP endpoint using this encoding.
 *
 * Method names (PascalCase, as per A2A v1.0 spec):
 *   SendMessage, SendStreamingMessage, GetTask, ListTasks, CancelTask,
 *   SubscribeToTask, GetExtendedAgentCard, CreateTaskPushNotificationConfig,
 *   GetTaskPushNotificationConfig, ListTaskPushNotificationConfigs,
 *   DeleteTaskPushNotificationConfig
 *
 * A2A-specific error codes (in addition to standard JSON-RPC codes):
 *   -32001 TaskNotFoundError
 *   -32002 TaskNotCancelableError
 *   -32003 PushNotificationNotSupportedError
 *   -32005 UnsupportedOperationError
 *   -32006 ContentTypeNotSupportedError
 *   -32007 InvalidAgentResponseError
 */

import { WeaveIntelError, newUUIDv7 } from '@weaveintel/core';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccess<T = unknown> {
  readonly jsonrpc: '2.0';
  readonly id: string;
  readonly result: T;
}

export interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | null;
  readonly error: JsonRpcErrorBody;
}

export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcErrorResponse;

// ─── A2A method name constants ────────────────────────────────────────────────

/** A2A v1.0 JSON-RPC method names (PascalCase, exact wire values). */
export const A2A_METHODS = {
  SEND_MESSAGE: 'SendMessage',
  SEND_STREAMING_MESSAGE: 'SendStreamingMessage',
  GET_TASK: 'GetTask',
  LIST_TASKS: 'ListTasks',
  CANCEL_TASK: 'CancelTask',
  SUBSCRIBE_TO_TASK: 'SubscribeToTask',
  GET_EXTENDED_AGENT_CARD: 'GetExtendedAgentCard',
  CREATE_PUSH_CONFIG: 'CreateTaskPushNotificationConfig',
  GET_PUSH_CONFIG: 'GetTaskPushNotificationConfig',
  LIST_PUSH_CONFIGS: 'ListTaskPushNotificationConfigs',
  DELETE_PUSH_CONFIG: 'DeleteTaskPushNotificationConfig',
} as const;

export type A2AMethod = (typeof A2A_METHODS)[keyof typeof A2A_METHODS];

// ─── A2A error codes ──────────────────────────────────────────────────────────

/** Standard JSON-RPC 2.0 + A2A v1.0 error codes. */
export const A2A_ERROR_CODES = {
  // Standard JSON-RPC
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // A2A v1.0 application errors
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32005,
  CONTENT_TYPE_NOT_SUPPORTED: -32006,
  INVALID_AGENT_RESPONSE: -32007,
} as const;

/** Thrown when a JSON-RPC response contains an `error` field. */
export class A2AJsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'A2AJsonRpcError';
  }
}

// ─── Codec ────────────────────────────────────────────────────────────────────

/**
 * Build a JSON-RPC 2.0 request envelope.
 * `id` defaults to a UUID v7 so it's traceable in logs.
 */
export function makeRpcRequest(method: string, params?: unknown, id?: string): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: id ?? newUUIDv7(),
    method,
    params,
  };
}

/** Build a JSON-RPC 2.0 success response. */
export function makeRpcSuccess<T>(id: string, result: T): JsonRpcSuccess<T> {
  return { jsonrpc: '2.0', id, result };
}

/** Build a JSON-RPC 2.0 error response. */
export function makeRpcError(
  id: string | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

/**
 * Parse a JSON-RPC 2.0 response body.
 * Throws `A2AJsonRpcError` if the response contains an `error` field.
 * Throws `WeaveIntelError` if the body is not a valid JSON-RPC 2.0 response.
 */
export function parseRpcResponse<T>(body: unknown): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new WeaveIntelError({
      code: 'PROTOCOL_ERROR',
      message: 'A2A response is not a JSON-RPC 2.0 object',
    });
  }
  const resp = body as Record<string, unknown>;
  if (resp['jsonrpc'] !== '2.0') {
    throw new WeaveIntelError({
      code: 'PROTOCOL_ERROR',
      message: `A2A response missing "jsonrpc": "2.0" field (got: ${String(resp['jsonrpc'])})`,
    });
  }
  if ('error' in resp) {
    const err = resp['error'] as JsonRpcErrorBody;
    throw new A2AJsonRpcError(err.code, err.message, err.data);
  }
  if ('result' in resp) {
    return resp['result'] as T;
  }
  throw new WeaveIntelError({
    code: 'PROTOCOL_ERROR',
    message: 'A2A JSON-RPC response has neither "result" nor "error" field',
  });
}

/**
 * Parse the `method` and `params` from a raw JSON body for server-side dispatch.
 * Throws `A2AJsonRpcError` with PARSE_ERROR / INVALID_REQUEST codes on invalid input.
 */
export function parseRpcRequest(raw: string): JsonRpcRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new A2AJsonRpcError(A2A_ERROR_CODES.PARSE_ERROR, 'Parse error: invalid JSON body');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new A2AJsonRpcError(A2A_ERROR_CODES.INVALID_REQUEST, 'Invalid Request: expected a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  if (obj['jsonrpc'] !== '2.0') {
    throw new A2AJsonRpcError(
      A2A_ERROR_CODES.INVALID_REQUEST,
      `Invalid Request: "jsonrpc" must be "2.0" (got "${String(obj['jsonrpc'])}")`,
    );
  }
  if (typeof obj['method'] !== 'string' || !obj['method']) {
    throw new A2AJsonRpcError(A2A_ERROR_CODES.INVALID_REQUEST, 'Invalid Request: "method" must be a non-empty string');
  }
  if (obj['id'] !== undefined && typeof obj['id'] !== 'string' && typeof obj['id'] !== 'number') {
    throw new A2AJsonRpcError(A2A_ERROR_CODES.INVALID_REQUEST, 'Invalid Request: "id" must be string or number if present');
  }

  return {
    jsonrpc: '2.0',
    id: String(obj['id'] ?? newUUIDv7()),
    method: obj['method'] as string,
    params: obj['params'],
  };
}
