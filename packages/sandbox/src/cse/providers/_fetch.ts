/**
 * Shared safe-fetch helper for CSE cluster-API and cloud-token requests.
 *
 * Bakes in two defaults that every cluster-API/cloud-token call needs:
 *   - request timeout via `AbortSignal.timeout` (default 30s, override per-call)
 *   - streaming response-size cap (default 10 MiB, override per-call)
 *
 * Returns a Response-like object with the body already consumed (and capped),
 * exposing `text()` and `json()` synchronously for ergonomics. JSON parse
 * failure is non-fatal — `data` is `null` and the raw `text` is preserved.
 *
 * Callers MAY pass their own `signal` — if so, both signals are respected
 * (whichever fires first wins) via AbortSignal.any().
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

export interface CseFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export interface CseFetchResult {
  ok: boolean;
  status: number;
  text: string;
  data: unknown;
}

export async function cseFetch(
  input: string,
  init: RequestInit & { dispatcher?: unknown } = {},
  opts: CseFetchOptions = {},
): Promise<CseFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;

  const resp = await fetch(input, { ...init, signal });

  let text = '';
  if (resp.body) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error(
          `CSE response exceeded ${maxBytes} bytes (url=${input})`,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } else {
    text = await resp.text();
  }

  let data: unknown = null;
  if (text.length > 0) {
    try { data = JSON.parse(text); } catch { data = null; }
  }

  return { ok: resp.ok, status: resp.status, text, data };
}
