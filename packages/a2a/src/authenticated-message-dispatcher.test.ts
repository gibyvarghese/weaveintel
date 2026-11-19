import { describe, expect, it, vi } from 'vitest';
import type { A2AServer, ExecutionContext } from '@weaveintel/core';
import { createAuthenticatedA2AMessageDispatcher } from './authenticated-message-dispatcher.js';
import { A2A_ERROR_CODES, A2A_METHODS } from './jsonrpc.js';

const principal: ExecutionContext = { executionId: 'exec', tenantId: 'kauri', userId: 'person', metadata: {} };
const request = (method: string, params: unknown = { message: { role: 'user', parts: [{ text: 'hello' }] } }) => ({
  method: 'POST',
  headers: { authorization: 'verified-by-host' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 'one', method, params }),
});

function fixture() {
  const handleMessage = vi.fn().mockResolvedValue({
    id: 'result', contextId: 'generated', status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-01-01T00:00:00Z' },
    artifacts: [], history: [],
  });
  const impl = { handleMessage } as unknown as A2AServer;
  const authenticate = vi.fn().mockResolvedValue(principal);
  const authorize = vi.fn().mockResolvedValue(true);
  return { handleMessage, authenticate, authorize, dispatch: createAuthenticatedA2AMessageDispatcher(impl, { authenticate, authorize }) };
}

describe('authenticated independent A2A messages', () => {
  it('uses the verified context rather than identity supplied in the message', async () => {
    const f = fixture();
    const params = { tenantId: 'other', userId: 'attacker', message: { role: 'user', parts: [{ text: 'hello' }] } };
    const result = await f.dispatch(request(A2A_METHODS.SEND_MESSAGE, params));
    expect(result).toMatchObject({ kind: 'json', status: 200 });
    expect(f.authorize).toHaveBeenCalledWith(principal, params);
    expect(f.handleMessage).toHaveBeenCalledWith(principal, expect.anything());
  });

  it('rejects absent and incomplete authentication without invoking the agent', async () => {
    for (const context of [undefined, { ...principal, tenantId: '' }, { ...principal, userId: undefined }]) {
      const f = fixture();
      f.authenticate.mockResolvedValue(context);
      expect(await f.dispatch(request(A2A_METHODS.SEND_MESSAGE))).toMatchObject({ status: 401 });
      expect(f.authorize).not.toHaveBeenCalled();
      expect(f.handleMessage).not.toHaveBeenCalled();
    }
  });

  it('denies explicit authorization refusal without invoking the agent', async () => {
    const f = fixture();
    f.authorize.mockResolvedValue(false);
    const result = await f.dispatch(request(A2A_METHODS.SEND_MESSAGE));
    expect(result).toMatchObject({ status: 403, data: { error: { code: A2A_ERROR_CODES.UNAUTHORIZED } } });
    expect(f.handleMessage).not.toHaveBeenCalled();
  });

  it('reports authentication infrastructure failures as sanitized 500 errors', async () => {
    const f = fixture();
    f.authenticate.mockRejectedValue(new Error('private credential details'));
    const result = await f.dispatch(request(A2A_METHODS.SEND_MESSAGE));
    expect(result).toMatchObject({ status: 500, data: { error: { code: A2A_ERROR_CODES.INTERNAL_ERROR } } });
    expect(JSON.stringify(result)).not.toContain('private credential details');
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.handleMessage).not.toHaveBeenCalled();
  });

  it('reports authorization infrastructure failures as sanitized 500 errors', async () => {
    const f = fixture();
    f.authorize.mockRejectedValue(new Error('private policy details'));
    const result = await f.dispatch(request(A2A_METHODS.SEND_MESSAGE));
    expect(result).toMatchObject({ status: 500, data: { error: { code: A2A_ERROR_CODES.INTERNAL_ERROR } } });
    expect(JSON.stringify(result)).not.toContain('private policy details');
    expect(f.handleMessage).not.toHaveBeenCalled();
  });

  it('rejects task, subscription, streaming and push operations before authorization', async () => {
    for (const method of [A2A_METHODS.GET_TASK, A2A_METHODS.LIST_TASKS, A2A_METHODS.CANCEL_TASK,
      A2A_METHODS.SUBSCRIBE_TO_TASK, A2A_METHODS.SEND_STREAMING_MESSAGE, A2A_METHODS.CREATE_PUSH_CONFIG]) {
      const f = fixture();
      expect(await f.dispatch(request(method))).toMatchObject({ status: 400, data: { error: { code: A2A_ERROR_CODES.UNSUPPORTED_OPERATION } } });
      expect(f.authorize).not.toHaveBeenCalled();
      expect(f.handleMessage).not.toHaveBeenCalled();
    }
  });

  it('rejects supplied conversation and task references rather than resuming another task', async () => {
    for (const key of ['taskId', 'contextId', 'referenceTaskIds']) {
      for (const atMessage of [false, true]) {
        const f = fixture();
        const message = { role: 'user', parts: [{ text: 'hello' }], ...(atMessage ? { [key]: 'other' } : {}) };
        const params = { message, ...(!atMessage ? { [key]: 'other' } : {}) };
        expect(await f.dispatch(request(A2A_METHODS.SEND_MESSAGE, params))).toMatchObject({ status: 400 });
        expect(f.handleMessage).not.toHaveBeenCalled();
      }
    }
  });

  it('keeps the authorized request unchanged while callbacks are running', async () => {
    const f = fixture();
    const req = request(A2A_METHODS.SEND_MESSAGE);
    f.authenticate.mockImplementation(async () => {
      req.body = request(A2A_METHODS.SEND_MESSAGE, { message: { role: 'user', parts: [{ text: 'changed' }] } }).body;
      return principal;
    });
    f.authorize.mockImplementation(async (_context, params) => {
      expect(Object.isFrozen(params.message.parts[0])).toBe(true);
      return true;
    });
    expect(await f.dispatch(req)).toMatchObject({ status: 200 });
    expect(f.handleMessage).toHaveBeenCalledWith(principal, expect.objectContaining({
      message: expect.objectContaining({ parts: [{ text: 'hello' }] }),
    }));
  });
});
