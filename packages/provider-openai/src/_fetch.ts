/**
 * Hardened fetch for the OpenAI provider client. Default-on — no opt-in flag.
 *
 * Mitigates:
 *   - operator-overridable `baseUrl` SSRF/MITM (compromised admin could point
 *     `baseUrl` at attacker-controlled host to exfiltrate prompts) → HTTPS
 *     enforcement with loopback exception (localhost / 127.0.0.1 / ::1) for
 *     local mock servers and testcontainer fixtures.
 *   - hung vendor APIs (OpenAI 5xx + slow-loris) → outer 60s timeout via
 *     AbortSignal.timeout, composed with caller's signal (which already
 *     carries `ExecutionContext.deadline` via `composeRequestSignal`) so the
 *     tighter caller deadline still wins.
 *   - oversized response bodies → streaming 50 MiB cap that wraps the body
 *     in a ReadableStream so existing `.json()` / `.text()` / `.arrayBuffer()`
 *     consumers work without rewrites. The cap is permissive because TTS
 *     audio + file downloads can be large; callers requiring more (or less)
 *     pass `maxBytes` explicitly.
 *
 * SSE / NDJSON streaming endpoints (chat.completions stream, files content
 * download for big files) consume `response.body.getReader()` directly and
 * are inherently long-running — they call `assertHttpsOrLoopback(url)` only
 * and then a plain `fetch(url, …)` so the outer timeout/size cap don't
 * terminate a healthy stream.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB

export interface OpenAIFetchOptions {
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
    throw new Error(`provider-openai: invalid URL "${url}"`);
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && isLoopback(parsed.hostname)) return;
  throw new Error(
    `provider-openai: refusing non-HTTPS request to "${parsed.hostname}" (only loopback may use http://).`,
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
          controller.error(new Error(`provider-openai: response body exceeded ${maxBytes} bytes`));
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

export async function openaiFetch(
  input: string,
  init?: RequestInit,
  opts: OpenAIFetchOptions = {},
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
      throw new Error(`provider-openai: response Content-Length ${n} exceeds limit ${maxBytes}`);
    }
  }

  const cappedBody = wrapBodyWithSizeCap(resp.body, maxBytes);
  return new Response(cappedBody, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}
