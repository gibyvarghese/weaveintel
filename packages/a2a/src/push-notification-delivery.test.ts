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

// Pushes never follow a redirect, same-origin or not: the connection is pinned to the address the guard checked,
// so a webhook cannot bounce the push (with its signature and credentials) anywhere else. A 3xx is a failed
// delivery and is not retried. The receivers here are on loopback, which a push must opt into.
const localReceiver = { policy: { outbound: { allowLoopback: true } }, retryDelaysMs: [] } as const;

describe('webhook hardened egress', () => {
  it('does not follow a same-origin redirect: nothing is forwarded, the 3xx is a failed delivery', async () => {
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
      }, payload, localReceiver);
      expect(result).toMatchObject({ delivered: false, attempts: 1 });
      expect(result.lastError).toMatch(/redirect refused/i);
      expect(received).toBeUndefined();
    } finally {
      await close(server);
    }
  });

  it('does not follow a cross-origin redirect and forwards neither payload nor credentials', async () => {
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
      }, payload, localReceiver);
      expect(result).toMatchObject({ delivered: false, attempts: 1 });
      expect(result.lastError).toMatch(/redirect refused/i);
      expect(forwarded).toBe(0);
    } finally {
      await close(source);
      await close(target);
    }
  }, 15_000);
});
