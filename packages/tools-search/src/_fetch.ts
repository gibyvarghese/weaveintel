/**
 * Hardened fetch for search providers. Default-on — no opt-in flag.
 *
 * Mitigates:
 *   - hung provider requests → request-level timeout via AbortSignal.
 *   - oversized response bodies → streaming size cap.
 *   - cleartext exfiltration → HTTPS enforced unless host is loopback.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface SearchFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  enforceHttps?: boolean;
}

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

function assertHttpsOrLoopback(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`tools-search: invalid URL "${url}"`); }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && isLoopback(parsed.hostname)) return;
  throw new Error(`tools-search: refusing non-HTTPS request to "${parsed.hostname}" (only loopback may use http://).`);
}

function wrapBodyWithSizeCap(body: ReadableStream<Uint8Array> | null, maxBytes: number): ReadableStream<Uint8Array> | null {
  if (!body) return body;
  let total = 0;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) { controller.close(); return; }
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          controller.error(new Error(`tools-search: response body exceeded ${maxBytes} bytes`));
          return;
        }
        controller.enqueue(value);
      } catch (err) { controller.error(err); }
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
}

export async function searchFetch(
  input: string,
  init?: RequestInit,
  opts: SearchFetchOptions = {},
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
      throw new Error(`tools-search: response Content-Length ${n} exceeds limit ${maxBytes}`);
    }
  }

  const cappedBody = wrapBodyWithSizeCap(resp.body, maxBytes);
  return new Response(cappedBody, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}
