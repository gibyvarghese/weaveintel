/**
 * Unit tests for JSON-RPC 2.0 codec (jsonrpc.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  A2A_METHODS,
  A2A_ERROR_CODES,
  A2AJsonRpcError,
  makeRpcRequest,
  makeRpcSuccess,
  makeRpcError,
  parseRpcResponse,
  parseRpcRequest,
} from './jsonrpc.js';

describe('A2A_METHODS', () => {
  it('exports all A2A v1.0 method names', () => {
    expect(A2A_METHODS.SEND_MESSAGE).toBe('SendMessage');
    expect(A2A_METHODS.SEND_STREAMING_MESSAGE).toBe('SendStreamingMessage');
    expect(A2A_METHODS.GET_TASK).toBe('GetTask');
    expect(A2A_METHODS.LIST_TASKS).toBe('ListTasks');
    expect(A2A_METHODS.CANCEL_TASK).toBe('CancelTask');
    expect(A2A_METHODS.SUBSCRIBE_TO_TASK).toBe('SubscribeToTask');
    expect(A2A_METHODS.GET_EXTENDED_AGENT_CARD).toBe('GetExtendedAgentCard');
    expect(A2A_METHODS.CREATE_PUSH_CONFIG).toBe('CreateTaskPushNotificationConfig');
    expect(A2A_METHODS.GET_PUSH_CONFIG).toBe('GetTaskPushNotificationConfig');
    expect(A2A_METHODS.LIST_PUSH_CONFIGS).toBe('ListTaskPushNotificationConfigs');
    expect(A2A_METHODS.DELETE_PUSH_CONFIG).toBe('DeleteTaskPushNotificationConfig');
  });
});

describe('A2A_ERROR_CODES', () => {
  it('exports standard JSON-RPC error codes', () => {
    expect(A2A_ERROR_CODES.PARSE_ERROR).toBe(-32700);
    expect(A2A_ERROR_CODES.INVALID_REQUEST).toBe(-32600);
    expect(A2A_ERROR_CODES.METHOD_NOT_FOUND).toBe(-32601);
    expect(A2A_ERROR_CODES.INVALID_PARAMS).toBe(-32602);
    expect(A2A_ERROR_CODES.INTERNAL_ERROR).toBe(-32603);
  });

  it('exports A2A application error codes', () => {
    expect(A2A_ERROR_CODES.TASK_NOT_FOUND).toBe(-32001);
    expect(A2A_ERROR_CODES.TASK_NOT_CANCELABLE).toBe(-32002);
    expect(A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED).toBe(-32003);
    expect(A2A_ERROR_CODES.UNSUPPORTED_OPERATION).toBe(-32005);
    expect(A2A_ERROR_CODES.CONTENT_TYPE_NOT_SUPPORTED).toBe(-32006);
    expect(A2A_ERROR_CODES.INVALID_AGENT_RESPONSE).toBe(-32007);
  });
});

describe('makeRpcRequest', () => {
  it('produces a valid JSON-RPC 2.0 request', () => {
    const req = makeRpcRequest('SendMessage', { message: { role: 'user', parts: [{ text: 'hi' }] } });
    expect(req.jsonrpc).toBe('2.0');
    expect(req.method).toBe('SendMessage');
    expect(req.id).toBeTruthy();
    expect(typeof req.id).toBe('string');
    expect((req.params as Record<string, unknown>)['message']).toBeDefined();
  });

  it('uses provided id', () => {
    const req = makeRpcRequest('GetTask', { id: 'task-1' }, 'my-id');
    expect(req.id).toBe('my-id');
  });

  it('generates unique ids', () => {
    const ids = new Set([
      makeRpcRequest('GetTask').id,
      makeRpcRequest('GetTask').id,
      makeRpcRequest('GetTask').id,
    ]);
    expect(ids.size).toBe(3);
  });
});

describe('makeRpcSuccess', () => {
  it('produces a valid success response', () => {
    const res = makeRpcSuccess('req-1', { id: 'task-1', status: { state: 'TASK_STATE_COMPLETED' } });
    expect(res.jsonrpc).toBe('2.0');
    expect(res.id).toBe('req-1');
    expect(res.result).toMatchObject({ id: 'task-1' });
    expect('error' in res).toBe(false);
  });
});

describe('makeRpcError', () => {
  it('produces a valid error response', () => {
    const res = makeRpcError('req-1', A2A_ERROR_CODES.TASK_NOT_FOUND, 'Task not found');
    expect(res.jsonrpc).toBe('2.0');
    expect(res.id).toBe('req-1');
    expect(res.error.code).toBe(-32001);
    expect(res.error.message).toBe('Task not found');
    expect('result' in res).toBe(false);
  });

  it('accepts null id (for parse errors before id is known)', () => {
    const res = makeRpcError(null, A2A_ERROR_CODES.PARSE_ERROR, 'Bad JSON');
    expect(res.id).toBeNull();
  });
});

describe('parseRpcResponse', () => {
  it('extracts result from a success response', () => {
    const raw = { jsonrpc: '2.0', id: 'r1', result: { id: 'task-1' } };
    const result = parseRpcResponse<{ id: string }>(raw);
    expect(result).toEqual({ id: 'task-1' });
  });

  it('throws A2AJsonRpcError when response has error field', () => {
    const raw = { jsonrpc: '2.0', id: 'r1', error: { code: -32001, message: 'Not found' } };
    expect(() => parseRpcResponse(raw)).toThrow(A2AJsonRpcError);
  });

  it('thrown error has correct code and message', () => {
    const raw = { jsonrpc: '2.0', id: 'r1', error: { code: -32001, message: 'Not found', data: { taskId: 'x' } } };
    let caught: A2AJsonRpcError | null = null;
    try {
      parseRpcResponse(raw);
    } catch (err) {
      caught = err as A2AJsonRpcError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe(-32001);
    expect(caught!.message).toBe('Not found');
    expect(caught!.data).toEqual({ taskId: 'x' });
  });

  it('throws WeaveIntelError for non-object response', () => {
    expect(() => parseRpcResponse(null)).toThrow();
    expect(() => parseRpcResponse('string')).toThrow();
    expect(() => parseRpcResponse([1, 2])).toThrow();
  });

  it('throws when jsonrpc is not 2.0', () => {
    expect(() => parseRpcResponse({ jsonrpc: '1.0', id: 'r1', result: {} })).toThrow();
  });

  it('throws when neither result nor error present', () => {
    expect(() => parseRpcResponse({ jsonrpc: '2.0', id: 'r1' })).toThrow();
  });
});

describe('parseRpcRequest', () => {
  it('parses a valid JSON-RPC 2.0 request body', () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'r1',
      method: 'SendMessage',
      params: { message: { role: 'user', parts: [{ text: 'hello' }] } },
    });
    const req = parseRpcRequest(body);
    expect(req.jsonrpc).toBe('2.0');
    expect(req.id).toBe('r1');
    expect(req.method).toBe('SendMessage');
    expect((req.params as Record<string, unknown>)['message']).toBeDefined();
  });

  it('throws PARSE_ERROR for invalid JSON', () => {
    let caught: A2AJsonRpcError | null = null;
    try { parseRpcRequest('{not json'); } catch (e) { caught = e as A2AJsonRpcError; }
    expect(caught?.code).toBe(A2A_ERROR_CODES.PARSE_ERROR);
  });

  it('throws INVALID_REQUEST when jsonrpc is not 2.0', () => {
    let caught: A2AJsonRpcError | null = null;
    try { parseRpcRequest(JSON.stringify({ jsonrpc: '1.0', id: '1', method: 'Foo' })); } catch (e) { caught = e as A2AJsonRpcError; }
    expect(caught?.code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
  });

  it('throws INVALID_REQUEST when method is missing', () => {
    let caught: A2AJsonRpcError | null = null;
    try { parseRpcRequest(JSON.stringify({ jsonrpc: '2.0', id: '1' })); } catch (e) { caught = e as A2AJsonRpcError; }
    expect(caught?.code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
  });

  it('throws INVALID_REQUEST for non-object body', () => {
    let caught: A2AJsonRpcError | null = null;
    try { parseRpcRequest('"just a string"'); } catch (e) { caught = e as A2AJsonRpcError; }
    expect(caught?.code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
  });

  it('generates id when not provided', () => {
    const req = parseRpcRequest(JSON.stringify({ jsonrpc: '2.0', method: 'GetTask', params: {} }));
    expect(typeof req.id).toBe('string');
    expect(req.id).toBeTruthy();
  });

  it('converts numeric id to string', () => {
    const req = parseRpcRequest(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'GetTask', params: {} }));
    expect(req.id).toBe('42');
  });
});

describe('A2AJsonRpcError', () => {
  it('is an instance of Error', () => {
    const err = new A2AJsonRpcError(-32001, 'Not found');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('A2AJsonRpcError');
    expect(err.code).toBe(-32001);
    expect(err.message).toBe('Not found');
  });
});
