import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { weaveOtlpSink } from './otel-tracer.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const span = {
  traceId: 'trace', spanId: 'span', name: 'test',
  startTime: 1, endTime: 2, status: 'ok' as const, attributes: {}, events: [],
};

describe('OTLP hardened egress', () => {
  it('sends a trace to a same-origin collector redirect', async () => {
    let received: { authorization?: string; body: string } | undefined;
    const collector = createServer((req, res) => {
      if (req.url === '/v1/traces') {
        res.writeHead(307, { location: '/collector' }).end();
        return;
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        received = { authorization: req.headers.authorization, body };
        res.writeHead(200).end();
      });
    });
    const endpoint = await listen(collector);
    try {
      const onExportError = vi.fn();
      const sink = weaveOtlpSink({ endpoint, apiKey: 'test-token', onExportError });
      sink.record(span);
      await sink.flush?.();
      expect(onExportError).not.toHaveBeenCalled();
      expect(received?.authorization).toBe('Bearer test-token');
      expect(JSON.parse(received?.body ?? '').resourceSpans[0].scopeSpans[0].spans[0].name).toBe('test');
    } finally {
      await close(collector);
    }
  });

  it('reports blocked cross-origin redirects without forwarding traces or credentials', async () => {
    let forwarded = 0;
    const target = createServer((_req, res) => { forwarded++; res.writeHead(200).end(); });
    const targetUrl = await listen(target);
    const collector = createServer((_req, res) => {
      res.writeHead(307, { location: `${targetUrl}/collector` }).end();
    });
    const endpoint = await listen(collector);
    try {
      const onExportError = vi.fn();
      const sink = weaveOtlpSink({ endpoint, apiKey: 'test-token', onExportError });
      sink.record(span);
      await sink.flush?.();
      expect(onExportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/cross-origin/) }));
      expect(forwarded).toBe(0);
    } finally {
      await close(collector);
      await close(target);
    }
  });
});
