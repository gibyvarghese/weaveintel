/**
 * Hardened fetch for the Google (Gemini) provider client. Default-on — no opt-in flag.
 *
 * See `packages/provider-openai/src/_fetch.ts` for the design rationale; this
 * file is the same shape with `provider-google` namespacing on errors.
 *
 * Google SSE streams (`streamGenerateContent`) call `assertHttpsOrLoopback(url)`
 * only — no outer timeout, no size cap.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export interface GoogleFetchOptions {
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
    throw new Error(`provider-google: invalid URL "${url}"`);
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && isLoopback(parsed.hostname)) return;
  throw new Error(
    `provider-google: refusing non-HTTPS request to "${parsed.hostname}" (only loopback may use http://).`,
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
          controller.error(new Error(`provider-google: response body exceeded ${maxBytes} bytes`));
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

export async function googleFetch(
  input: string,
  init?: RequestInit,
  opts: GoogleFetchOptions = {},
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
      throw new Error(`provider-google: response Content-Length ${n} exceeds limit ${maxBytes}`);
    }
  }

  const cappedBody = wrapBodyWithSizeCap(resp.body, maxBytes);
  return new Response(cappedBody, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}
