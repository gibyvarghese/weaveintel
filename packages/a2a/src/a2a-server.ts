/**
 * @weaveintel/a2a — JSON-RPC 2.0 server dispatcher (Phase 2)
 *
 * `createA2ADispatcher` wraps an `A2AServer` implementation and exposes a
 * framework-agnostic dispatch function. Wire it into any HTTP server:
 *
 *   const dispatcher = createA2ADispatcher(myServer);
 *   const result = await dispatcher(ctx, { method, body, headers });
 *   // result is { kind: 'json', status, data } or { kind: 'stream', events, taskId, contextId }
 *
 * geneWeave wires this at POST /api/a2a.
 * `weaveA2AServer` is a convenience re-export for callers who want the function by name.
 *
 * A2A v1.0 method dispatch table:
 *   SendMessage                       → handleMessage()
 *   SendStreamingMessage              → handleStreamMessage() + SSE
 *   GetTask                           → getTask()
 *   ListTasks                         → listTasks()
 *   CancelTask                        → cancelTask()
 *   SubscribeToTask                   → handleStreamMessage() on existing task (SSE)
 *   GetExtendedAgentCard              → getExtendedCard() (optional)
 *   CreateTaskPushNotificationConfig  → UnsupportedOperation (Phase 5)
 *   GetTaskPushNotificationConfig     → UnsupportedOperation (Phase 5)
 *   ListTaskPushNotificationConfigs   → UnsupportedOperation (Phase 5)
 *   DeleteTaskPushNotificationConfig  → UnsupportedOperation (Phase 5)
 */

import type {
  A2AServer,
  A2ATask,
  A2ATaskSendParams,
  A2AListTasksFilter,
  A2AStreamEvent,
  ExecutionContext,
} from '@weaveintel/core';
import {
  A2A_METHODS,
  A2A_ERROR_CODES,
  A2AJsonRpcError,
  makeRpcSuccess,
  makeRpcError,
  parseRpcRequest,
  type JsonRpcErrorResponse,
  type JsonRpcSuccess,
} from './jsonrpc.js';
import { sseData, sseComment } from './sse-parser.js';

// ─── Request / Response shapes ────────────────────────────────────────────────

export interface A2ADispatchRequest {
  readonly method: string;      // HTTP method (should be POST)
  readonly body: string;        // raw request body (UTF-8)
  readonly headers: Record<string, string | string[] | undefined>;
  readonly a2aVersion?: string; // value of A2A-Version header (pre-extracted)
}

export type A2ADispatchResult =
  | { readonly kind: 'json'; readonly status: number; readonly data: unknown }
  | { readonly kind: 'stream'; readonly events: AsyncIterable<A2AStreamEvent>; readonly taskId: string; readonly contextId: string };

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Create a JSON-RPC 2.0 dispatcher for an `A2AServer` implementation.
 * Returns a function that accepts a framework-agnostic request and produces
 * either a JSON response or an SSE stream result.
 */
export function createA2ADispatcher(impl: A2AServer): (
  ctx: ExecutionContext,
  req: A2ADispatchRequest,
) => Promise<A2ADispatchResult> {
  return async (ctx, req) => {
    if (req.method !== 'POST') {
      return {
        kind: 'json',
        status: 405,
        data: makeRpcError(null, A2A_ERROR_CODES.INVALID_REQUEST, 'A2A endpoint only accepts POST requests'),
      };
    }

    // Validate A2A-Version header (warn; don't hard-reject for flexibility)
    const a2aVersion = req.a2aVersion ?? resolveHeader(req.headers, 'a2a-version');
    if (a2aVersion && a2aVersion !== '1.0') {
      // Future: return VersionNotSupportedError for versions > 1.0
      // For now accept anything; we're a v1.0 server.
    }

    // Parse JSON-RPC 2.0 envelope
    let rpcReq: ReturnType<typeof parseRpcRequest>;
    try {
      rpcReq = parseRpcRequest(req.body);
    } catch (err) {
      const rpcErr = err instanceof A2AJsonRpcError ? err : new A2AJsonRpcError(A2A_ERROR_CODES.PARSE_ERROR, String(err));
      return {
        kind: 'json',
        status: 400,
        data: makeRpcError(null, rpcErr.code, rpcErr.message),
      };
    }

    const { id, method, params } = rpcReq;

    try {
      switch (method) {
        case A2A_METHODS.SEND_MESSAGE: {
          const sendParams = coerceTaskSendParams(params, id);
          const task = await impl.handleMessage(ctx, sendParams);
          return { kind: 'json', status: 200, data: makeRpcSuccess(id, task) };
        }

        case A2A_METHODS.SEND_STREAMING_MESSAGE: {
          const sendParams = coerceTaskSendParams(params, id);
          if (!impl.handleStreamMessage) {
            // Fall back to synchronous handleMessage — wrap as single terminal task event
            const task = await impl.handleMessage(ctx, sendParams);
            return {
              kind: 'stream',
              events: singleTaskStream(task),
              taskId: task.id,
              contextId: task.contextId,
            };
          }
          const p = sendParams;
          const taskId = (params as Record<string, unknown>)?.['taskId'] as string | undefined;
          const contextId = p.message.contextId ?? taskId ?? 'unknown';
          return {
            kind: 'stream',
            events: impl.handleStreamMessage(ctx, p),
            taskId: taskId ?? contextId,
            contextId,
          };
        }

        case A2A_METHODS.GET_TASK: {
          if (!impl.getTask) {
            throw new A2AJsonRpcError(A2A_ERROR_CODES.UNSUPPORTED_OPERATION, 'GetTask is not implemented by this agent');
          }
          const p = (params ?? {}) as Record<string, unknown>;
          const taskId = stringParam(p, 'id', id);
          const historyLength = typeof p['historyLength'] === 'number' ? p['historyLength'] : undefined;
          void historyLength; // forward to store in Phase 3; ignored here
          const task = await impl.getTask(ctx, taskId);
          if (!task) {
            throw new A2AJsonRpcError(A2A_ERROR_CODES.TASK_NOT_FOUND, `Task not found: ${taskId}`);
          }
          return { kind: 'json', status: 200, data: makeRpcSuccess(id, task) };
        }

        case A2A_METHODS.LIST_TASKS: {
          if (!impl.listTasks) {
            throw new A2AJsonRpcError(A2A_ERROR_CODES.UNSUPPORTED_OPERATION, 'ListTasks is not implemented by this agent');
          }
          const p = (params ?? {}) as Record<string, unknown>;
          const filter: A2AListTasksFilter = {
            contextId: p['contextId'] as string | undefined,
            state: p['status'] as A2AListTasksFilter['state'],
            pageSize: p['pageSize'] as number | undefined,
            pageToken: p['pageToken'] as string | undefined,
            statusTimestampAfter: p['statusTimestampAfter'] as string | undefined,
          };
          const page = await impl.listTasks(ctx, filter);
          return { kind: 'json', status: 200, data: makeRpcSuccess(id, page) };
        }

        case A2A_METHODS.CANCEL_TASK: {
          if (!impl.cancelTask) {
            throw new A2AJsonRpcError(A2A_ERROR_CODES.TASK_NOT_CANCELABLE, 'CancelTask is not implemented by this agent');
          }
          const p = (params ?? {}) as Record<string, unknown>;
          const taskId = stringParam(p, 'id', id);
          await impl.cancelTask(ctx, taskId);
          // A2A spec: return the updated task (CANCELED state) or an empty result
          // We return empty result since we don't have a task store in Phase 2
          return { kind: 'json', status: 200, data: makeRpcSuccess(id, { canceled: true }) };
        }

        case A2A_METHODS.SUBSCRIBE_TO_TASK: {
          if (!impl.handleStreamMessage) {
            throw new A2AJsonRpcError(A2A_ERROR_CODES.UNSUPPORTED_OPERATION, 'Streaming is not supported by this agent');
          }
          const p = (params ?? {}) as Record<string, unknown>;
          const taskId = stringParam(p, 'id', id);
          // Phase 2: re-subscribe by rerunning a "resume" task — Phase 3 will add real task store
          throw new A2AJsonRpcError(
            A2A_ERROR_CODES.UNSUPPORTED_OPERATION,
            `SubscribeToTask requires a task store (Phase 3). Task: ${taskId}`,
          );
        }

        case A2A_METHODS.GET_EXTENDED_AGENT_CARD: {
          const extended = (impl as { getExtendedCard?: (ctx: ExecutionContext) => Promise<unknown> }).getExtendedCard;
          if (!extended) {
            throw new A2AJsonRpcError(
              A2A_ERROR_CODES.UNSUPPORTED_OPERATION,
              'GetExtendedAgentCard is not supported by this agent',
            );
          }
          const card = await extended(ctx);
          return { kind: 'json', status: 200, data: makeRpcSuccess(id, card) };
        }

        case A2A_METHODS.CREATE_PUSH_CONFIG:
        case A2A_METHODS.GET_PUSH_CONFIG:
        case A2A_METHODS.LIST_PUSH_CONFIGS:
        case A2A_METHODS.DELETE_PUSH_CONFIG: {
          throw new A2AJsonRpcError(
            A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED,
            'Push notification configuration is not yet supported (Phase 5)',
          );
        }

        default: {
          throw new A2AJsonRpcError(
            A2A_ERROR_CODES.METHOD_NOT_FOUND,
            `Method not found: ${String(method)}`,
          );
        }
      }
    } catch (err) {
      if (err instanceof A2AJsonRpcError) {
        const status = err.code === A2A_ERROR_CODES.TASK_NOT_FOUND ? 404
          : err.code === A2A_ERROR_CODES.METHOD_NOT_FOUND ? 404
          : err.code === A2A_ERROR_CODES.PARSE_ERROR ? 400
          : err.code === A2A_ERROR_CODES.INVALID_REQUEST ? 400
          : 500;
        return { kind: 'json', status, data: makeRpcError(id, err.code, err.message, err.data) };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        kind: 'json',
        status: 500,
        data: makeRpcError(id, A2A_ERROR_CODES.INTERNAL_ERROR, `Internal error: ${message}`),
      };
    }
  };
}

/** Convenience alias matching the gap-analysis docs. */
export const weaveA2AServer = createA2ADispatcher;

// ─── SSE helpers ─────────────────────────────────────────────────────────────

/** Yields a single terminal `{ task }` event (for non-streaming fallback). */
async function* singleTaskStream(task: A2ATask): AsyncIterable<A2AStreamEvent> {
  yield { task };
}

/**
 * Encode an A2A stream into SSE wire format (for Node.js `res.write()`).
 *
 * Usage in geneWeave route:
 *   for await (const chunk of streamToSse(events)) {
 *     res.write(chunk);
 *   }
 */
export async function* streamToSse(events: AsyncIterable<A2AStreamEvent>): AsyncIterable<string> {
  for await (const event of events) {
    yield sseData(event);
  }
}

/** Emit a single A2AStreamEvent as an SSE data chunk. */
export function eventToSse(event: A2AStreamEvent): string {
  return sseData(event);
}

/** Keepalive SSE comment. */
export const SSE_KEEPALIVE = sseComment('keepalive');

// ─── Param coercion helpers ───────────────────────────────────────────────────

function resolveHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const val = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(val)) return val[0];
  return val;
}

function stringParam(params: Record<string, unknown>, key: string, rpcId: string): string {
  const val = params[key];
  if (typeof val !== 'string' || !val) {
    throw new A2AJsonRpcError(
      A2A_ERROR_CODES.INVALID_PARAMS,
      `Missing or invalid required param "${key}" in request ${rpcId}`,
    );
  }
  return val;
}

function coerceTaskSendParams(params: unknown, rpcId: string): A2ATaskSendParams {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new A2AJsonRpcError(
      A2A_ERROR_CODES.INVALID_PARAMS,
      `SendMessage params must be an object (request ${rpcId})`,
    );
  }
  const p = params as Record<string, unknown>;
  if (!p['message'] || typeof p['message'] !== 'object') {
    throw new A2AJsonRpcError(
      A2A_ERROR_CODES.INVALID_PARAMS,
      `SendMessage params.message is required (request ${rpcId})`,
    );
  }
  const msg = p['message'] as Record<string, unknown>;
  if (!Array.isArray(msg['parts'])) {
    throw new A2AJsonRpcError(
      A2A_ERROR_CODES.INVALID_PARAMS,
      `SendMessage params.message.parts must be an array (request ${rpcId})`,
    );
  }
  return params as A2ATaskSendParams;
}
