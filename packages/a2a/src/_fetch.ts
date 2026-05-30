/**
 * Hardened fetch for the A2A protocol client. Default-on — no opt-in flag.
 *
 * Mitigates:
 *   - hung remote agents (operator-configured agent URLs may be unreachable
 *     or extremely slow) → request-level timeout via AbortSignal, composed
 *     with the caller's `ctx.signal` so external cancellation still works.
 *   - oversized response bodies that would inflate memory → streaming size
 *     cap wrapping the response body; downstream `.json()` consumers get a
 *     tag-checked stream and abort on overflow.
 *   - cleartext A2A traffic (task payloads can carry sensitive intent) →
 *     HTTPS enforced unless the host is loopback (localhost / 127.0.0.1 / ::1
 *     for in-process dev fixtures and tests).
 *
 * `streamTask` consumes `response.body.getReader()` directly and is inherently
 * long-running, so it uses `assertHttpsOrLoopback` only — no hard timeout, no
 * size cap (would terminate a healthy SSE stream).
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

export interface A2AFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  enforceHttps?: boolean;
}

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

export function assertHttpsOrLoopback(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`a2a: invalid URL "${url}"`);
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && isLoopback(parsed.hostname)) return;
  throw new Error(
    `a2a: refusing non-HTTPS request to "${parsed.hostname}" (only loopback may use http://).`,
  );
}

function wrapBodyWithSizeCap(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): ReadableStream<Uint8Array> | null {
  if (!body) return body;
  let total = 0;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          controller.error(new Error(`a2a: response body exceeded ${maxBytes} bytes`));
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

/**
 * Hardened replacement for `fetch()` for use inside the A2A client.
 * Returns a real `Response` whose body is size-capped.
 *
 * Use this for unary requests (discover, sendTask, cancelTask, getTaskStatus).
 * For SSE streams (streamTask), call `assertHttpsOrLoopback(url)` and then a
 * plain `fetch(url, { signal: ctx.signal })` directly.
 */
export async function a2aFetch(
  input: string,
  init?: RequestInit,
  opts: A2AFetchOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const enforceHttps = opts.enforceHttps ?? true;

  if (enforceHttps) assertHttpsOrLoopback(input);

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const callerSignal = init?.signal;
  const signal = callerSignal
    ? AbortSignal.any([callerSignal as AbortSignal, timeoutSignal])
    : timeoutSignal;

  const resp = await fetch(input, { ...(init ?? {}), signal });

  const cl = resp.headers.get('content-length');
  if (cl) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) {
      try { await resp.body?.cancel(); } catch { /* ignore */ }
      throw new Error(`a2a: response Content-Length ${n} exceeds limit ${maxBytes}`);
    }
  }

  const cappedBody = wrapBodyWithSizeCap(resp.body, maxBytes);
  return new Response(cappedBody, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}
