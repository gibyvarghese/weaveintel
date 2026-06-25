/**
 * parseSseStream — THE canonical SSE byte→event decoder for the platform.
 *
 * Collaboration Phase 0 (de-duplication): this used to be re-implemented in
 * three places — `@weaveintel/client` (the run-stream transport), `@weaveintel/a2a`
 * (the agent-to-agent SSE reader), and `apps/geneweave-ui`. It now lives once in
 * `@weaveintel/core` (the dependency-light, browser-safe contracts package) and
 * everyone else consumes it. `@weaveintel/client` re-exports it; `@weaveintel/a2a`
 * layers a JSON `.map` on top.
 *
 * --- For someone new to this ---
 * "SSE" = Server-Sent Events: a simple text protocol where a server streams a
 * series of events to a client over one long-lived HTTP response. Each event is
 * a few `key: value` lines (`data:`, `event:`, …) followed by a blank line. This
 * function turns the raw bytes of that stream into one {@link SseEvent} object
 * per event, so callers can just `for await` over events instead of fiddling
 * with byte buffers and line splitting.
 *
 * It follows the WHATWG `text/event-stream` rules (HTML §9.2): one `TextDecoder`
 * per stream (so a multi-byte character split across two network chunks decodes
 * correctly), LF/CRLF/CR line endings, `data:` values joined with `\n`, `:comment`
 * keepalive lines ignored, dispatch on a blank line, and a trailing record
 * flushed if the stream ends without a final blank line. `id:`/`retry:` are
 * accepted-and-ignored (the run protocol carries its own sequence numbers).
 *
 * It adds two ergonomics the spec leaves to the host: an optional **stall
 * timeout** (reject if no bytes arrive within a window, so a dead connection
 * can't hang forever) and **cooperative cancellation** (abort via an
 * `AbortSignal`, or just `break` the loop — either cancels the underlying
 * reader).
 *
 * NOTE: browser-safe — uses only `ReadableStream` + `TextDecoder`; no Node APIs.
 */

/** A single decoded SSE record. */
export interface SseEvent {
  /** The joined `data:` payload (the empty string for a data-less record). */
  data: string;
  /** The `event:` field, when present. */
  event?: string;
}

export interface ParseSseOptions {
  /** Abort the read (and cancel the reader) when this fires. */
  signal?: AbortSignal;
  /**
   * Reject with a stall error if no bytes arrive within this window (ms).
   * 0 / undefined disables the timeout.
   */
  stallTimeoutMs?: number;
}

/** Thrown when `stallTimeoutMs` elapses with no incoming bytes. */
export class SseStallError extends Error {
  constructor(ms: number) {
    super(`SSE stream stalled — no data within ${ms}ms`);
    this.name = 'SseStallError';
  }
}

/**
 * Decode an SSE byte stream into discrete events.
 *
 * Consume with `for await (const ev of parseSseStream(stream, opts)) { ... }`.
 * `break`ing the loop (or aborting `opts.signal`) cancels the reader.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  opts: ParseSseOptions = {},
): AsyncGenerator<SseEvent, void, unknown> {
  const { signal, stallTimeoutMs = 0 } = opts;
  if (signal?.aborted) return;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let dataLines: string[] = [];
  let currentEvent: string | undefined;

  // Apply one already-CR-stripped line to the in-progress record.
  const applyLine = (line: string): void => {
    if (line.startsWith(':')) return; // comment / keepalive
    if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    // `id:` / `retry:` and any other field — ignored by the run protocol.
  };

  // Drain a completed record (blank-line boundary or end-of-stream). A record
  // with no `data:` line and no `event:` is whitespace/keepalive — skipped.
  const take = (): SseEvent | null => {
    if (dataLines.length === 0 && currentEvent === undefined) return null;
    const data = dataLines.join('\n');
    const evName = currentEvent;
    dataLines = [];
    currentEvent = undefined;
    return evName !== undefined ? { data, event: evName } : { data };
  };

  // Resolve abort as a clean end (not an error), racing it against read().
  let onAbort: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<{ aborted: true }>((resolve) => {
        onAbort = () => resolve({ aborted: true });
        signal.addEventListener('abort', onAbort, { once: true });
      })
    : null;

  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const races: Array<Promise<ReadableStreamReadResult<Uint8Array> | { aborted: true } | never>> = [
        reader.read(),
      ];
      if (abortPromise) races.push(abortPromise);
      if (stallTimeoutMs > 0) {
        races.push(
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new SseStallError(stallTimeoutMs)), stallTimeoutMs);
          }),
        );
      }

      let result: ReadableStreamReadResult<Uint8Array> | { aborted: true };
      try {
        result = await Promise.race(races);
      } finally {
        if (timer) clearTimeout(timer);
      }

      if ('aborted' in result) break;
      if (result.done) break;

      buf += decoder.decode(result.value, { stream: true });
      // Split on LF; the per-line `\r` strip below absorbs a trailing CR (CRLF).
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (line === '') {
          const ev = take();
          if (ev) yield ev;
        } else {
          applyLine(line);
        }
      }
    }
    // The stream ended: parse any trailing partial line still in the buffer,
    // then flush a final record if it had no terminating blank line.
    if (buf.length > 0) applyLine(buf.replace(/\r$/, ''));
    const tail = take();
    if (tail) yield tail;
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}
