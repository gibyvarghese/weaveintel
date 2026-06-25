/**
 * parseSseStream — the single SSE byte→event decoder for the platform.
 *
 * Phase 5 (G14): retires the duplicate hand-rolled SSE readers. Both the
 * production `sseTransport` (run API) and `apps/geneweave-ui` (chat POST-stream)
 * now feed their `ReadableStream<Uint8Array>` through this one parser instead of
 * each re-implementing `getReader()` + chunk buffering + line splitting.
 *
 * It is a framework-agnostic async generator that yields one {@link SseEvent}
 * per SSE record (terminated by a blank line, or a trailing record when the
 * stream ends without one). It handles:
 *  - LF and CRLF line endings,
 *  - multi-line `data:` (joined with `\n`, per the SSE spec),
 *  - `event:` names,
 *  - `id:` / `retry:` (ignored — not used by the run protocol),
 *  - `:comment` keepalive lines (ignored),
 *  - an optional stall timeout (reject if no bytes arrive within the window),
 *  - cooperative cancellation via an `AbortSignal` and/or `break`ing the loop
 *    (the generator's `return` path always cancels the underlying reader).
 *
 * NOTE: browser-safe — uses only `ReadableStream` + `TextDecoder`.
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
      // Split on LF; trimEnd() on each line absorbs a trailing CR (CRLF).
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
