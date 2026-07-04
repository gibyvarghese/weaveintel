import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeEndpoint, httpRequest } from './client.js';
import type { HttpEndpointConfig } from './types.js';

describe('@weaveintel/tools-http client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects private network hosts by default', async () => {
    await expect(httpRequest({ url: 'http://127.0.0.1/internal' })).rejects.toThrow(/Private network host is not allowed/);
  });

  it('enforces response size limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', {
      status: 200,
      statusText: 'OK',
      headers: { 'content-length': '2048' },
    })));

    await expect(httpRequest({
      url: 'http://127.0.0.1/test',
      allowPrivateNetwork: true,
      maxResponseBytes: 64,
    })).rejects.toThrow(/Response exceeds max size/);
  });

  it('does not retry non-retryable 4xx responses', async () => {
    const fetchMock = vi.fn(async () => new Response('bad request', { status: 400, statusText: 'Bad Request' }));
    vi.stubGlobal('fetch', fetchMock);

    const config: HttpEndpointConfig = {
      name: 'nonretryable-400',
      baseUrl: 'http://127.0.0.1/test',
      method: 'GET',
      retryCount: 3,
      retryDelayMs: 0,
      allowPrivateNetwork: true,
    };

    const response = await executeEndpoint(config, {});
    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx responses and succeeds on recovery', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('upstream down', { status: 502, statusText: 'Bad Gateway' }))
      .mockResolvedValueOnce(new Response('ok', { status: 200, statusText: 'OK' }));
    vi.stubGlobal('fetch', fetchMock);

    const config: HttpEndpointConfig = {
      name: 'retryable-502',
      baseUrl: 'http://127.0.0.1/test',
      method: 'GET',
      retryCount: 2,
      retryDelayMs: 0,
      allowPrivateNetwork: true,
    };

    const response = await executeEndpoint(config, {});
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry client-side rate-limit violations', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200, statusText: 'OK' }));
    vi.stubGlobal('fetch', fetchMock);

    const config: HttpEndpointConfig = {
      name: 'rate-limited-endpoint',
      baseUrl: 'http://127.0.0.1/test',
      method: 'GET',
      rateLimit: { requestsPerMinute: 1 },
      retryCount: 3,
      retryDelayMs: 0,
      allowPrivateNetwork: true,
    };

    await executeEndpoint(config, {});
    await expect(executeEndpoint(config, {})).rejects.toThrow(/Rate limit exceeded/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
