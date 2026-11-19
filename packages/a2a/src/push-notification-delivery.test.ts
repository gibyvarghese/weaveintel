import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { A2ATask } from '@weaveintel/core';
import { deliverToWebhook } from './push-notification-delivery.js';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

const task = { id: 'test', contextId: 'test', status: { state: 'TASK_STATE_COMPLETED' } } as A2ATask;
const payload = { task, timestamp: '2026-01-01T00:00:00Z' };

describe('webhook hardened egress', () => {
  it('retains the signed POST on a same-origin redirect', async () => {
    let received: { method?: string; authorization?: string; signature?: string; body: string } | undefined;
    const server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(307, { location: '/hook' }).end();
        return;
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        received = { method: req.method, authorization: req.headers.authorization,
          signature: req.headers['x-a2a-webhook-signature'] as string | undefined, body };
        res.writeHead(200).end();
      });
    });
    const port = await listen(server);
    try {
      const result = await deliverToWebhook({
        url: `http://127.0.0.1:${port}/redirect`, taskId: task.id, pushConfigId: '1', createdAt: '',
        token: 'test-signing-token', authentication: { schemes: ['bearer'], credentials: 'test-token' },
      }, payload);
      expect(result.delivered).toBe(true);
      expect(received).toMatchObject({ method: 'POST', authorization: 'Bearer test-token', body: JSON.stringify(payload) });
      expect(received?.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    } finally {
      await close(server);
    }
  });

  it('reports cross-origin redirect failures without forwarding payload or credentials', async () => {
    let forwarded = 0;
    const target = createServer((_req, res) => { forwarded++; res.writeHead(200).end(); });
    const targetPort = await listen(target);
    const source = createServer((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/hook` }).end();
    });
    const sourcePort = await listen(source);
    try {
      const result = await deliverToWebhook({
        url: `http://127.0.0.1:${sourcePort}/hook`, taskId: task.id, pushConfigId: '2', createdAt: '',
        authentication: { schemes: ['bearer'], credentials: 'test-token' },
      }, payload);
      expect(result).toMatchObject({ delivered: false, attempts: 4 });
      expect(result.lastError).toMatch(/cross-origin redirect/i);
      expect(forwarded).toBe(0);
    } finally {
      await close(source);
      await close(target);
    }
  }, 15_000);
});
