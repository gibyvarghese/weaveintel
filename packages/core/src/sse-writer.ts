// SPDX-License-Identifier: MIT
/**
 * Server-Sent Events WRITER (Collaboration Phase 6) — the emit half of the SSE
 * transport. `@weaveintel/core` already owns the canonical READER
 * (`parseSseStream`); this is its counterpart so the geneWeave run-stream route,
 * the a2a server, and any other producer format frames ONE way instead of three.
 *
 * --- For someone new to this ---
 * "Server-Sent Events" is a dead-simple streaming format: the server writes lines
 * of text, the browser's `EventSource` reads them. Each event looks like:
 *     id: 42
 *     event: message
 *     data: {"hello":"world"}
 *     <blank line>
 * The blank line ends the event. This module just builds that text correctly —
 * including the bits that make a stream RESUMABLE and proxy-proof:
 *   - `id:` on every event → on reconnect the browser auto-sends the last id back
 *     in the `Last-Event-ID` header, so the server can replay only what was missed.
 *   - `retry:` → tells the browser how long to wait before reconnecting.
 *   - comment frames (`: keepalive`) → keep idle proxies from killing the stream.
 *
 * Pure string formatting (browser-safe); the optional `writeSse*` helpers take any
 * object with a `write` method so they work with a Node `ServerResponse` without
 * importing `node:http`.
 */

/** Minimal sink — a Node `ServerResponse` satisfies this without importing http. */
export interface SseSink {
  write(chunk: string): boolean | void;
}

/** Response headers that make an SSE stream behave (no caching, no proxy buffering). */
export const SSE_RESPONSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no', // disable nginx proxy buffering
};

export interface SseFrame {
  /** Event id — echoed back by the browser as `Last-Event-ID` on reconnect. */
  id?: string | number;
  /** Named event type (`event:` line). Omit for the default `message` event. */
  event?: string;
  /** The payload. Objects are JSON-encoded; strings are sent verbatim. */
  data: unknown;
  /** Reconnection delay hint (ms) — emitted as a `retry:` line. */
  retry?: number;
}

/**
 * Format one SSE frame as wire text (ending in the blank-line separator).
 * Multi-line data is split across multiple `data:` lines per the SSE spec.
 */
export function formatSseFrame(frame: SseFrame): string {
  let out = '';
  if (frame.id !== undefined) out += `id: ${String(frame.id)}\n`;
  if (frame.event !== undefined) out += `event: ${frame.event}\n`;
  if (frame.retry !== undefined) out += `retry: ${Math.max(0, Math.floor(frame.retry))}\n`;
  const text = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
  for (const line of text.split('\n')) out += `data: ${line}\n`;
  return `${out}\n`;
}

/** A heartbeat comment frame (`: keepalive`) — ignored by clients, defeats idle timeouts. */
export function formatSseComment(text = 'keepalive'): string {
  return `: ${text}\n\n`;
}

/** Write a formatted SSE frame to a sink. Returns false if the sink rejected the write. */
export function writeSseFrame(sink: SseSink, frame: SseFrame): boolean {
  try { return sink.write(formatSseFrame(frame)) !== false; } catch { return false; }
}

/** Write a keepalive comment to a sink. */
export function writeSseComment(sink: SseSink, text = 'keepalive'): boolean {
  try { return sink.write(formatSseComment(text)) !== false; } catch { return false; }
}

/**
 * Resolve the resume cursor for a request: the standard `Last-Event-ID` header
 * (sent automatically by `EventSource` on reconnect) takes precedence, falling
 * back to an explicit `?after=` query value, else `defaultAfter`. Returns the
 * numeric sequence to resume AFTER. Non-numeric/empty ids fall through.
 */
export function resolveResumeCursor(opts: { lastEventId?: string | null; afterParam?: string | null; defaultAfter?: number }): number {
  const fromHeader = opts.lastEventId != null && opts.lastEventId !== '' ? Number(opts.lastEventId) : NaN;
  if (Number.isFinite(fromHeader)) return fromHeader;
  const fromParam = opts.afterParam != null && opts.afterParam !== '' ? Number(opts.afterParam) : NaN;
  if (Number.isFinite(fromParam)) return fromParam;
  return opts.defaultAfter ?? -1;
}
