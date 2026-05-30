/**
 * Internal safe-fetch helper for OAuth token + userinfo requests.
 *
 * Bakes in:
 *   • default 15s `AbortSignal.timeout` (composes with caller-supplied signal via `AbortSignal.any`)
 *   • streaming response-size cap (default 1 MiB) — token + userinfo payloads are
 *     small JSON; oversized responses are almost always a misconfigured/hostile endpoint
 *   • HTTPS-only enforcement — except for `localhost`/`127.0.0.1`/`::1` which are
 *     allowed for local dev (e.g. mock OAuth servers in tests). Plaintext token
 *     exchanges leak client secrets and access tokens.
 *
 * Returns a Response-like object with body already consumed; JSON parse failure
 * is non-fatal (`data: null`, raw `text` preserved) so callers can surface the
 * provider's plain-text error body.
 */

export interface OauthFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export interface OauthFetchResult {
  ok: boolean;
  status: number;
  text: string;
  data: unknown;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1 * 1024 * 1024;

function assertHttps(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`OAuth endpoint is not a valid URL: ${url}`);
  }
  if (u.protocol === 'https:') return;
  if (u.protocol === 'http:') {
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return;
    throw new Error(
      `OAuth endpoint must be https:// (got ${u.protocol}//${u.hostname}). Plaintext OAuth leaks credentials.`,
    );
  }
  throw new Error(`OAuth endpoint protocol not allowed: ${u.protocol}`);
}

export async function oauthFetch(
  input: string,
  init: RequestInit = {},
  opts: OauthFetchOptions = {},
): Promise<OauthFetchResult> {
  assertHttps(input);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;

  const resp = await fetch(input, { ...init, signal });

  // Stream and enforce size cap.
  let total = 0;
  const chunks: Uint8Array[] = [];
  const reader = resp.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          throw new Error(`OAuth response exceeded ${maxBytes} bytes (url=${input})`);
        }
        chunks.push(value);
      }
    }
  }

  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const text = buf.toString('utf8');
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  return { ok: resp.ok, status: resp.status, text, data };
}
