/**
 * @weaveintel/a2a — SSE stream parser
 *
 * A2A v1.0 SSE format:
 *   - Each event is a `data:` line containing a JSON `A2AStreamEvent`
 *     (field-presence union: { task } | { message } | { statusUpdate } | { artifactUpdate })
 *   - No `[DONE]` sentinel — stream closes when the server closes the connection
 *   - Comment lines (`: keepalive`) are ignored
 *   - Blank lines separate events (per SSE spec)
 *
 * Note: For `SendStreamingMessage`, the SSE data is the unwrapped `A2AStreamEvent`
 * directly — it is NOT wrapped in a JSON-RPC 2.0 envelope on the wire.
 */

/**
 * Parse a `ReadableStream<Uint8Array>` SSE body into a typed async iterable.
 * Handles chunked UTF-8 delivery correctly (chunks may split event boundaries).
 * Skips empty lines, comment lines (starting with `:`), and invalid JSON payloads.
 */
export async function* parseSseStream<T>(body: ReadableStream<Uint8Array>): AsyncIterable<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines (\n\n or \r\n\r\n).
      // Split on newlines and collect complete events.
      const lines = buffer.split('\n');
      // The last element may be an incomplete line — keep it in buffer.
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trimEnd();

        // Ignore comment lines (keepalive pings)
        if (trimmed.startsWith(':')) continue;

        // Data line — extract payload
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6).trim();

          // A2A v1.0 has no [DONE] sentinel — stream ends when connection closes.
          // Kept here for resilience against misconfigured legacy servers.
          if (!data || data === '[DONE]') continue;

          try {
            yield JSON.parse(data) as T;
          } catch {
            // Malformed JSON — skip silently; don't break the stream.
          }
        }
        // Other field types (event:, id:, retry:) are ignored.
      }
    }
  } finally {
    reader.releaseLock();
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
