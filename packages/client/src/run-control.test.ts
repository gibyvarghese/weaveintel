// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { createRunControlChannel, type MinimalWebSocket } from './run-control.js';

/** A fake WebSocket that records sent frames and lets a test push server messages. */
class FakeSocket implements MinimalWebSocket {
  readyState = 1; // OPEN
  sent: Array<Record<string, unknown>> = [];
  #listeners: Record<string, Array<(ev: unknown) => void>> = {};
  closed = false;
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.closed = true; }
  addEventListener(type: string, listener: (ev: unknown) => void): void {
    (this.#listeners[type] ??= []).push(listener);
  }
  /** Simulate the server pushing a message to the client. */
  serverSend(obj: Record<string, unknown>): void {
    for (const l of this.#listeners['message'] ?? []) l({ data: JSON.stringify(obj) });
  }
}

function makeChannel(over: Partial<Parameters<typeof createRunControlChannel>[0]> = {}) {
  let sock!: FakeSocket;
  const Impl = function (this: unknown) { sock = new FakeSocket(); return sock; } as unknown as new (url: string) => MinimalWebSocket;
  let n = 0;
  const ch = createRunControlChannel({ url: 'ws://x/control', WebSocketImpl: Impl, genRequestId: () => `r${++n}`, ...over });
  return { ch, get sock() { return sock; } };
}

describe('createRunControlChannel', () => {
  it('sends a cancel with a requestId and resolves on the matching ack', async () => {
    const { ch, sock } = makeChannel();
    const p = ch.cancel();
    expect(sock.sent[0]).toMatchObject({ type: 'cancel', requestId: 'r1' });
    sock.serverSend({ type: 'ack', requestId: 'r1', ok: true, cancelled: true });
    expect(await p).toMatchObject({ ok: true, cancelled: true });
  });

  it('rejects when the server returns an error for the request', async () => {
    const { ch, sock } = makeChannel();
    const p = ch.steer({ text: 'go left' });
    expect(sock.sent[0]).toMatchObject({ type: 'steer', payload: { text: 'go left' } });
    sock.serverSend({ type: 'error', requestId: 'r1', error: 'forbidden: viewers cannot steer' });
    await expect(p).rejects.toThrow(/viewers cannot steer/);
  });

  it('replies pong to a server ping (liveness)', () => {
    const { ch, sock } = makeChannel();
    sock.serverSend({ type: 'ping' });
    expect(sock.sent.find((m) => m['type'] === 'pong')).toBeTruthy();
    ch.close();
    expect(sock.closed).toBe(true);
  });

  it('routes the connect state.snapshot to onSnapshot', () => {
    let snap: unknown;
    const { sock } = makeChannel({ onSnapshot: (s) => { snap = s; } });
    sock.serverSend({ type: 'state.snapshot', run: { id: 'r1', status: 'running' }, role: 'owner', presence: [] });
    expect(snap).toMatchObject({ run: { id: 'r1', status: 'running' }, role: 'owner' });
  });

  it('concurrent requests resolve to their own acks (no cross-talk)', async () => {
    const { ch, sock } = makeChannel();
    const a = ch.presence({ presence: 'online' });
    const b = ch.cancel();
    expect(sock.sent.map((m) => m['requestId'])).toEqual(['r1', 'r2']);
    sock.serverSend({ type: 'ack', requestId: 'r2', ok: true, cancelled: true });
    sock.serverSend({ type: 'ack', requestId: 'r1', ok: true });
    expect(await b).toMatchObject({ cancelled: true });
    expect(await a).toMatchObject({ ok: true });
  });
});
