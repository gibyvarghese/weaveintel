/**
 * @weaveintel/a2a — JSON-RPC 2.0 server dispatcher (Phase 3)
 *
 * `createA2ADispatcher` wraps an `A2AServer` implementation and exposes a
 * framework-agnostic dispatch function. Wire it into any HTTP server:
 *
 *   const dispatcher = createA2ADispatcher(myServer, store);
 *   const result = await dispatcher(ctx, { method, body, headers });
 *   // result is { kind: 'json', status, data } or { kind: 'stream', events, taskId, contextId }
 *
 * A host application typically wires this at POST /api/a2a.
 * `weaveA2AServer` is a convenience re-export for callers who want the function by name.
 *
 * A2A v1.0 method dispatch table:
 *   SendMessage                       → handleMessage()
 *   SendStreamingMessage              → handleStreamMessage() + SSE
 *   GetTask                           → getTask()
 *   ListTasks                         → listTasks()
 *   CancelTask                        → cancelTask()
 *   SubscribeToTask                   → store.subscribe() SSE stream (Phase 3)
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
  A2APushNotificationConfig,
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
import type { A2ATaskStore } from './task-store.js';
import { isTerminalA2AState } from './task-store.js';
import type { A2APushNotificationStore } from './push-notification-store.js';
import type { JwtValidatorFn } from './jwt-validator.js';
import { deliverPushNotificationsForTask } from './push-notification-delivery.js';

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
 *
 * @param impl         - The A2AServer to dispatch to.
 * @param store        - Optional task store; enables GetTask, ListTasks, SubscribeToTask.
 * @param pushStore    - Optional push store; enables push notification CRUD methods.
 * @param jwtValidator - Optional JWT validator; enforces Bearer token auth on all requests.
 */
export function createA2ADispatcher(
  impl: A2AServer,
  store?: A2ATaskStore,
  pushStore?: A2APushNotificationStore,
  jwtValidator?: JwtValidatorFn,
): (
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

    // JWT validation — run before dispatch when validator is configured
    if (jwtValidator) {
      const authHeader = resolveHeader(req.headers, 'authorization') ?? '';
      const skillId = extractSkillId(params);
      const payload = await jwtValidator(authHeader, { skillId });
      if (!payload) {
        return {
          kind: 'json',
          status: 401,
          data: makeRpcError(id, A2A_ERROR_CODES.UNAUTHORIZED, 'Unauthorized: missing or invalid bearer token'),
        };
      }
    }

    try {
      switch (method) {
        case A2A_METHODS.SEND_MESSAGE: {
          const sendParams = coerceTaskSendParams(params, id);
          const task = await impl.handleMessage(ctx, sendParams);
          // Trigger push delivery after task completes
          if (pushStore && isTerminalA2AState(task.status.state)) {
            void deliverPushNotificationsForTask(pushStore, task).catch(() => {});
          }
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
          // A2A spec: return the updated (CANCELED) task. Load from store if available.
          const canceledTask = store ? await store.load(taskId) : null;
          return { kind: 'json', status: 200, data: makeRpcSuccess(id, canceledTask ?? { canceled: true, id: taskId }) };
        }

        case A2A_METHODS.SUBSCRIBE_TO_TASK: {
          const p = (params ?? {}) as Record<string, unknown>;
          const taskId = stringParam(p, 'id', id);

          if (!store?.subscribe) {
            throw new A2AJsonRpcError(
              A2A_ERROR_CODES.UNSUPPORTED_OPERATION,
              `SubscribeToTask requires a task store with subscribe support. Task: ${taskId}`,
            );
          }

          const taskStream = store.subscribe(taskId);
          return {
            kind: 'stream',
            events: taskUpdatesToStreamEvents(taskStream),
            taskId,
            contextId: taskId, // contextId resolved from first task event
          };
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

        case A2A_METHODS.CREATE_PUSH_CONFIG: {
          if (!pushStore) {
            throw new A2AJsonRpcError(
              A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED,
              'Push notifications are not configured on this agent',
            );
          }
          const p = (params ?? {}) as Record<string, unknown>;
          const taskId = stringParam(p, 'taskId', id);
          const rawConfig = p['config'] as A2APushNotificationConfig | undefined;
          if (!rawConfig || typeof rawConfig.url !== 'string') {
            throw new A2AJsonRpcError(A2A_ERROR_CODES.INVALID_PARAMS, 'CreateTaskPushNotificationConfig: params.config.url is required');
          }
          const entry = impl.createPushConfig
            ? await impl.createPushConfig(ctx, taskId, rawConfig)
            : await pushStore.create(taskId, rawConfig);
          return { kind: 'json', status: 200, data: makeRpcSuccess(id, entry) };
        }

        case A2A_METHODS.GET_PUSH_CONFIG: {
          if (!pushStore) {
            throw new A2AJsonRpcError(
              A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED,
              'Push notifications are not configured on this agent',
            );
          }
          const p = (params ?? {}) as Record<string, unknown>;
          const taskId = stringParam(p, 'taskId', id);
          const configId = stringParam(p, 'pushConfigId', id);
          const entry = impl.getPushConfig
            ? await impl.getPushConfig(ctx, taskId, configId)
            : await pushStore.get(taskId, configId);
          if (!entry) {
            throw new A2AJsonRpcError(A2A_ERROR_CODES.TASK_NOT_FOUND, `Push config not found: ${configId}`);
          }
          return { kind: 'json', status: 200, data: makeRpcSuccess(id, entry) };
        }

        case A2A_METHODS.LIST_PUSH_CONFIGS: {
          if (!pushStore) {
            throw new A2AJsonRpcError(
              A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED,
              'Push notifications are not configured on this agent',
            );
          }
          const p = (params ?? {}) as Record<string, unknown>;
          const taskId = stringParam(p, 'taskId', id);
          const configs = impl.listPushConfigs
            ? await impl.listPushConfigs(ctx, taskId)
            : await pushStore.list(taskId);
          return { kind: 'json', status: 200, data: makeRpcSuccess(id, { configs }) };
        }

        case A2A_METHODS.DELETE_PUSH_CONFIG: {
          if (!pushStore) {
            throw new A2AJsonRpcError(
              A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED,
              'Push notifications are not configured on this agent',
            );
          }
          const p = (params ?? {}) as Record<string, unknown>;
          const taskId = stringParam(p, 'taskId', id);
          const configId = stringParam(p, 'pushConfigId', id);
          const deleted = impl.deletePushConfig
            ? await impl.deletePushConfig(ctx, taskId, configId)
            : await pushStore.delete(taskId, configId);
          if (!deleted) {
            throw new A2AJsonRpcError(A2A_ERROR_CODES.TASK_NOT_FOUND, `Push config not found: ${configId}`);
          }
          return { kind: 'json', status: 200, data: makeRpcSuccess(id, { deleted: true }) };
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
          : err.code === A2A_ERROR_CODES.INVALID_PARAMS ? 400
          : err.code === A2A_ERROR_CODES.UNAUTHORIZED ? 401
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
 * Convert a task-store subscription (AsyncIterable<A2ATask>) into A2AStreamEvents
 * for SubscribeToTask. Non-terminal states emit { statusUpdate }; terminal states
 * emit { task } and then close.
 */
async function* taskUpdatesToStreamEvents(
  taskUpdates: AsyncIterable<A2ATask>,
): AsyncIterable<A2AStreamEvent> {
  for await (const task of taskUpdates) {
    if (isTerminalA2AState(task.status.state)) {
      yield { task };
      return;
    }
    yield {
      statusUpdate: {
        taskId: task.id,
        contextId: task.contextId,
        status: task.status,
      },
    };
  }
}

/**
 * Encode an A2A stream into SSE wire format (for Node.js `res.write()`).
 *
 * Usage in a host application route:
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

function extractSkillId(params: unknown): string | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const p = params as Record<string, unknown>;
  const msg = p['message'];
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return undefined;
  const meta = (msg as Record<string, unknown>)['metadata'];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const skillId = (meta as Record<string, unknown>)['skillId'];
  return typeof skillId === 'string' ? skillId : undefined;
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
