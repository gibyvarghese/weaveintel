/**
 * Hardened fetch for enterprise connectors. Default-on — no opt-in flag.
 *
 * Mitigates:
 *   - hung connector requests (operator-configured base URLs can be unreachable
 *     or extremely slow) → request-level timeout via AbortSignal.
 *   - oversized response bodies that would inflate memory → streaming size cap
 *     wrapping the response body; downstream `.json()` / `.text()` /
 *     `.arrayBuffer()` consumers get a tag-checked stream and abort on overflow.
 *   - cleartext exfiltration to plain-HTTP MITM hosts → HTTPS enforced unless
 *     the host is loopback (localhost / 127.0.0.1 / ::1 — for dev fixtures).
 *
 * Connector-specific allowlists (e.g. `validateBaseUrl` enforcing
 * `*.service-now.com`) still run upstream of this helper. This helper is the
 * universal floor.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

export interface EnterpriseFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Set false to skip HTTPS enforcement (e.g. operator already validated). */
  enforceHttps?: boolean;
}

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

function assertHttpsOrLoopback(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`enterprise: invalid URL "${url}"`);
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && isLoopback(parsed.hostname)) return;
  throw new Error(
    `enterprise: refusing non-HTTPS request to "${parsed.hostname}" (only loopback may use http://).`,
  );
}

function wrapBodyWithSizeCap(body: ReadableStream<Uint8Array> | null, maxBytes: number): ReadableStream<Uint8Array> | null {
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
          controller.error(new Error(`enterprise: response body exceeded ${maxBytes} bytes`));
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
 * Hardened replacement for `fetch()` for use inside enterprise connectors.
 * Returns a real `Response` whose body is size-capped.
 */
export async function enterpriseFetch(
  input: string,
  init?: RequestInit,
  opts: EnterpriseFetchOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const enforceHttps = opts.enforceHttps ?? true;

  if (enforceHttps) assertHttpsOrLoopback(input);

  // Compose caller signal with timeout signal so external cancellation still works.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const callerSignal = init?.signal;
  const signal = callerSignal
    ? AbortSignal.any([callerSignal as AbortSignal, timeoutSignal])
    : timeoutSignal;

  const resp = await fetch(input, { ...(init ?? {}), signal });

  // Cheap pre-check: reject if Content-Length is announced over the cap.
  const cl = resp.headers.get('content-length');
  if (cl) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) {
      // Drain to free the socket.
      try { await resp.body?.cancel(); } catch { /* ignore */ }
      throw new Error(`enterprise: response Content-Length ${n} exceeds limit ${maxBytes}`);
    }
  }

  const cappedBody = wrapBodyWithSizeCap(resp.body, maxBytes);
  return new Response(cappedBody, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}
