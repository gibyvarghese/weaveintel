// SPDX-License-Identifier: MIT
/**
 * Run CONTROL CHANNEL client (Collaboration Phase 6) — the browser/Node side of
 * the bidirectional WebSocket control plane. SSE streams a run's output one way;
 * this lets the client talk BACK: cancel, steer, heartbeat presence.
 *
 * --- For someone new to this ---
 * The page opens a two-way connection and can send small "control" messages while
 * a run is going. Every message gets a unique `requestId`, so if the connection
 * blips and the client retries, the server recognises the duplicate and does not
 * act twice (idempotent). On (re)connect the server sends a `state.snapshot`, so
 * control + presence survive a tab switch, not just a reload.
 *
 * Transport-agnostic: pass a `WebSocketImpl` (the global `WebSocket` in a browser,
 * or the `ws` package in Node) so the same code runs everywhere and is unit-
 * testable with a fake socket.
 */

export type ControlAck = { type: 'ack'; requestId?: string; ok: boolean; [k: string]: unknown };
export type ControlError = { type: 'error'; requestId?: string; error: string };
export interface ControlSnapshot { type: 'state.snapshot'; run: { id: string; status: string }; role: string; presence: unknown[] }

/** A minimal WebSocket shape (both the browser global and `ws` satisfy it). */
export interface MinimalWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  addEventListener?(type: string, listener: (ev: unknown) => void): void;
  on?(type: string, listener: (...args: unknown[]) => void): void;
}
export type WebSocketImpl = new (url: string) => MinimalWebSocket;

export interface RunControlChannelOptions {
  /** Full ws(s):// URL to the control endpoint, INCLUDING the `?ticket=` query. */
  url: string;
  /** WebSocket constructor (browser global, or `ws`). */
  WebSocketImpl: WebSocketImpl;
  /** Generate a request id (defaults to a random-ish counter; injectable for tests). */
  genRequestId?: () => string;
  onSnapshot?: (snap: ControlSnapshot) => void;
  onMessage?: (msg: Record<string, unknown>) => void;
}

export interface RunControlChannel {
  /** Owner-only: cancel the run. Resolves with the server ack. */
  cancel(): Promise<ControlAck>;
  /** Collaborator+: send a steering note/payload. */
  steer(payload: Record<string, unknown>): Promise<ControlAck>;
  /** Any participant: heartbeat presence. */
  presence(body?: { presence?: string; displayName?: string; cursor?: Record<string, unknown> }): Promise<ControlAck>;
  /** Close the channel. */
  close(): void;
}

export function createRunControlChannel(opts: RunControlChannelOptions): RunControlChannel {
  let counter = 0;
  const genRequestId = opts.genRequestId ?? (() => `req-${++counter}-${Date.now()}`);
  const ws = new opts.WebSocketImpl(opts.url);
  const pending = new Map<string, { resolve: (a: ControlAck) => void; reject: (e: Error) => void }>();

  const handle = (data: string): void => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    const type = msg['type'];
    if (type === 'state.snapshot') { opts.onSnapshot?.(msg as unknown as ControlSnapshot); return; }
    if (type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* */ } return; }
    const requestId = typeof msg['requestId'] === 'string' ? msg['requestId'] : undefined;
    if ((type === 'ack' || type === 'error') && requestId && pending.has(requestId)) {
      const p = pending.get(requestId)!;
      pending.delete(requestId);
      if (type === 'error') p.reject(new Error(String((msg as ControlError).error)));
      else p.resolve(msg as ControlAck);
      return;
    }
    opts.onMessage?.(msg);
  };

  // Bind both event styles (browser `addEventListener`, Node `ws` `on`).
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener('message', (ev: unknown) => handle(String((ev as { data: unknown }).data)));
  } else if (typeof ws.on === 'function') {
    ws.on('message', (data: unknown) => handle(typeof data === 'string' ? data : String(data)));
  }

  const sendControl = (type: string, extra: Record<string, unknown>): Promise<ControlAck> => {
    const requestId = genRequestId();
    return new Promise<ControlAck>((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      try { ws.send(JSON.stringify({ type, requestId, ...extra })); }
      catch (err) { pending.delete(requestId); reject(err instanceof Error ? err : new Error('send failed')); }
    });
  };

  return {
    cancel() { return sendControl('cancel', {}); },
    steer(payload) { return sendControl('steer', { payload }); },
    presence(body) { return sendControl('presence', body ?? {}); },
    close() { try { ws.close(); } catch { /* */ } },
  };
}
