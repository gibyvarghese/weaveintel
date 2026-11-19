import type { A2AServer, ExecutionContext } from '@weaveintel/core';
import { createA2ADispatcher, type A2ADispatchRequest, type A2ADispatchResult } from './a2a-server.js';
import { A2A_ERROR_CODES, A2A_METHODS, A2AJsonRpcError, makeRpcError, parseRpcRequest } from './jsonrpc.js';

/**
 * Host callbacks must verify credentials and authorize the requested operation.
 * The authenticated context must not be derived from JSON-RPC arguments.
 */
export interface AuthenticatedA2AMessageOptions {
  readonly authenticate: (headers: A2ADispatchRequest['headers']) => Promise<ExecutionContext | undefined>;
  readonly authorize: (context: ExecutionContext, params: unknown) => Promise<boolean>;
}

function freezeJson(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object') continue;
    for (const child of Object.values(current)) pending.push(child);
    Object.freeze(current);
  }
}

/**
 * A deliberately limited, opt-in A2A dispatcher for independent messages.
 *
 * This does not open a network endpoint. It exposes no task, subscription,
 * streaming or push APIs and rejects client-supplied conversation references.
 * The host must enforce request-size limits, authenticate the transport, apply
 * resource and field authorization, and use an isolated or stateless server.
 * This adapter does not make another route or an unscoped task store safe.
 */
export function createAuthenticatedA2AMessageDispatcher(
  impl: A2AServer,
  options: AuthenticatedA2AMessageOptions,
): (req: A2ADispatchRequest) => Promise<A2ADispatchResult> {
  const dispatch = createA2ADispatcher(impl);
  const error = (status: number, id: string | null, code: number, message: string): A2ADispatchResult =>
    ({ kind: 'json', status, data: makeRpcError(id, code, message) });

  return async (req) => {
    const request = { ...req, headers: { ...req.headers } };
    if (request.method !== 'POST') {
      return error(405, null, A2A_ERROR_CODES.INVALID_REQUEST, 'A2A endpoint only accepts POST requests');
    }

    let context: ExecutionContext | undefined;
    try {
      context = await options.authenticate(request.headers);
    } catch {
      return error(500, null, A2A_ERROR_CODES.INTERNAL_ERROR, 'Authentication service error');
    }
    if (typeof context?.tenantId !== 'string' || context.tenantId.trim() === '' ||
        typeof context.userId !== 'string' || context.userId.trim() === '') {
      return error(401, null, A2A_ERROR_CODES.UNAUTHORIZED, 'Unauthenticated');
    }

    let rpc: ReturnType<typeof parseRpcRequest>;
    try {
      rpc = parseRpcRequest(request.body);
    } catch (cause) {
      const code = cause instanceof A2AJsonRpcError ? cause.code : A2A_ERROR_CODES.PARSE_ERROR;
      return error(400, null, code, 'Invalid JSON-RPC request');
    }
    if (rpc.method !== A2A_METHODS.SEND_MESSAGE) {
      return error(400, rpc.id, A2A_ERROR_CODES.UNSUPPORTED_OPERATION, 'Only independent SendMessage is supported');
    }

    const params = rpc.params;
    if (params && typeof params === 'object' && !Array.isArray(params)) {
      const p = params as Record<string, unknown>;
      const message = p['message'];
      const refs = ['taskId', 'contextId', 'referenceTaskIds'];
      if (refs.some((key) => key in p) ||
        (message !== null && typeof message === 'object' && refs.some((key) => key in message))) {
        return error(400, rpc.id, A2A_ERROR_CODES.UNSUPPORTED_OPERATION, 'Conversation and task references are not supported');
      }
    }

    freezeJson(params);
    try {
      if (await options.authorize(context, params) !== true) {
        return error(403, rpc.id, A2A_ERROR_CODES.UNAUTHORIZED, 'Forbidden');
      }
    } catch {
      return error(500, rpc.id, A2A_ERROR_CODES.INTERNAL_ERROR, 'Authorization service error');
    }
    return dispatch(context, request);
  };
}
