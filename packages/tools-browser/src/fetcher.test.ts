import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchPage } from './fetcher.js';

describe('@weaveintel/tools-browser fetcher', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects private network hosts by default', async () => {
    await expect(fetchPage({ url: 'http://127.0.0.1/internal', timeout: 1000 })).rejects.toThrow(/Private network host is not allowed/);
  });

  it('enforces response size limits', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', {
      status: 200,
      headers: { 'content-length': '2048' },
    })));

    await expect(fetchPage({
      url: 'http://127.0.0.1/test',
      allowPrivateNetwork: true,
      maxResponseBytes: 64,
      timeout: 1000,
    })).rejects.toThrow(/Response exceeds max size/);
  });

  it('returns fetch metadata for valid requests', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>ok</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPage({
      url: 'http://127.0.0.1/page',
      allowPrivateNetwork: true,
      timeout: 1000,
    });

    expect(result.status).toBe(200);
    expect(result.html).toContain('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
