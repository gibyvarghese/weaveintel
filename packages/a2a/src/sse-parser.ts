/**
 * @weaveintel/a2a — SSE helpers for the A2A wire protocol.
 *
 * Collaboration Phase 0 (de-duplication): the byte→event DECODING used to be a
 * second hand-rolled copy of the loop that also lived in `@weaveintel/client`.
 * It now delegates to the ONE canonical `parseSseStream` in `@weaveintel/core`;
 * this module only layers the A2A-specific JSON typing + the server-side emit
 * helpers on top.
 *
 * A2A v1.0 SSE format:
 *   - Each event is a `data:` line containing a JSON `A2AStreamEvent`
 *     (field-presence union: { task } | { message } | { statusUpdate } | { artifactUpdate })
 *   - No `[DONE]` sentinel — the stream closes when the server closes the connection
 *   - Comment lines (`: keepalive`) are ignored
 *   - Blank lines separate events (per the SSE spec)
 *
 * Note: For `SendStreamingMessage`, the SSE data is the unwrapped `A2AStreamEvent`
 * directly — it is NOT wrapped in a JSON-RPC 2.0 envelope on the wire.
 */
import { parseSseStream as parseSseBytes } from '@weaveintel/core';

/**
 * Parse an A2A SSE body into a typed async iterable of JSON events.
 *
 * Wraps the core SSE decoder: each `data:` record's text is `JSON.parse`d into
 * `T`. Empty records, the legacy `[DONE]` sentinel, and malformed JSON are
 * skipped silently so one bad frame never breaks the stream.
 */
export async function* parseSseStream<T>(body: ReadableStream<Uint8Array>): AsyncIterable<T> {
  for await (const ev of parseSseBytes(body)) {
    const data = ev.data.trim();
    // A2A v1.0 has no [DONE] sentinel — kept for resilience against legacy servers.
    if (!data || data === '[DONE]') continue;
    try {
      yield JSON.parse(data) as T;
    } catch {
      // Malformed JSON — skip silently; don't break the stream.
    }
  }
}

/**
 * Build an SSE `data:` line from an event object.
 * Used by `weaveA2AServer` when emitting streaming responses.
 */
export function sseData(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Build an SSE comment (keepalive ping).
 */
export function sseComment(text: string): string {
  return `: ${text}\n\n`;
}
