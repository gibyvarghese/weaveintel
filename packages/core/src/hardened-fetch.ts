/**
 * The single hardened egress client for the framework.
 *
 * Composes the five outbound-safety primitives every package needs:
 *   1. SSRF guard          — `assertSafeOutboundUrl` (cloud metadata, RFC1918, DNS rebinding)
 *   2. Redirect re-validation — `followRedirectsSafely` (manual 3xx walk, each hop re-validated)
 *   3. TLS / HTTPS floor   — http:// permitted only for loopback when `allowLoopback`
 *   4. Outer timeout       — `AbortSignal.timeout(timeoutMs)`, composed with caller signal
 *   5. Response size cap   — streaming wrapper that errors past `maxBytes`
 *
 * Phase 1 of the enterprise-hardening plan: this REPLACES the 13 hand-rolled
 * `_fetch.ts` files scattered across providers / tools / connectors. Each of
 * those packages should now expose a thin closure built via `createHardenedFetch`
 * with its own error tag and defaults — never re-implement the pipeline.
 *
 * Long-lived streams (SSE, NDJSON, chunked download) MUST NOT pass through the
 * outer timeout. Use `hardenedFetchNoTimeout` (or set `timeoutMs: 0`) and
 * consume `response.body` directly — the SSRF guard + redirect re-validation
 * still apply.
 *
 * Depends only on `@weaveintel/core` itself (`net-guard`) + node built-ins.
 */

import dns from 'node:dns';
import {
  type OutboundUrlPolicy,
  assertSafeOutboundUrl,
  followRedirectsSafely,
  validateResolvedAddress,
} from './net-guard.js';

/**
 * Phase 5 — TOCTOU DNS-pinning dispatcher.
 *
 * `assertSafeOutboundUrl` resolves DNS once at validation time. Between that
 * resolution and the actual TCP connection, an attacker who controls DNS could
 * rebind the hostname to a private IP — the classic SSRF bypass via DNS
 * rebinding. This factory closes that window.
 *
 * It creates an undici `Agent` with a custom `connect.lookup` hook. Undici
 * calls our hook at connection time (not earlier), so the IP we validate is
 * exactly the IP undici connects to. A rebind between the two resolutions
 * becomes impossible.
 *
 * Graceful degradation: if undici is unavailable (non-Node environments or
 * bundlers that strip it) the function returns `undefined` and callers fall
 * back to the pre-TOCTOU behaviour — still protected by the upfront
 * `assertSafeOutboundUrl` check.
 */
async function createSafeDispatcher(
  policy: OutboundUrlPolicy,
): Promise<{ dispatcher: unknown } | undefined> {
  let AgentCtor: (new (opts: Record<string, unknown>) => unknown) | undefined;
  try {
    const undici = await import('undici') as { Agent: new (opts: Record<string, unknown>) => unknown };
    AgentCtor = undici.Agent;
  } catch {
    return undefined; // undici unavailable — graceful degradation
  }

  // Undici's connect.lookup may ask for either a single resolved address or
  // all candidates (`all:true`). Handle both callback shapes and validate each
  // candidate so we never pass an undefined/unsafe address to the socket layer.
  const lookup = (
    hostname: string,
    options: unknown,
    callback: (...args: unknown[]) => void,
  ): void => {
    const wantsAll =
      typeof options === 'object' &&
      options !== null &&
      'all' in options &&
      (options as { all?: boolean }).all === true;

    if (wantsAll) {
      dns.lookup(hostname, { all: true }, (err, addresses) => {
        if (err) {
          callback(err);
          return;
        }
        try {
          for (const entry of addresses) {
            validateResolvedAddress(entry.address, policy);
          }
          callback(null, addresses);
        } catch (e) {
          callback(e as NodeJS.ErrnoException);
        }
      });
      return;
    }

    dns.lookup(hostname, (err, address, family) => {
      if (err) {
        callback(err);
        return;
      }
      if (!address || typeof address !== 'string') {
        callback(new TypeError(`invalid DNS lookup result for host "${hostname}"`) as NodeJS.ErrnoException);
        return;
      }
      try {
        validateResolvedAddress(address, policy);
        callback(null, address, family);
      } catch (e) {
        callback(e as NodeJS.ErrnoException);
      }
    });
  };

  const agent = new AgentCtor({ connect: { lookup } });
  return { dispatcher: agent };
}

export interface HardenedFetchOptions {
  /** Outer wall-clock timeout in ms. Default: 60_000. Use 0 to disable (streaming). */
  timeoutMs?: number;
  /** Max bytes the response body may yield. Default: 50 MiB. Use 0 to disable. */
  maxBytes?: number;
  /** Enforce HTTPS + SSRF guard + redirect re-validation. Default: true. */
  enforceHttps?: boolean;
  /** Outbound URL policy forwarded to the SSRF guard. */
  policy?: OutboundUrlPolicy;
  /** Override the `redirect` mode. Default: 'manual' so the guard can re-validate. */
  redirect?: RequestRedirect;
}

export interface HardenedFetchDefaults {
  /** Error tag inserted into thrown messages (e.g. 'provider-openai'). REQUIRED. */
  errorTag: string;
  /** Default timeoutMs for this client. Default: 60_000. */
  timeoutMs?: number;
  /** Default maxBytes for this client. Default: 50 MiB. */
  maxBytes?: number;
  /** Default policy for the SSRF guard (extra blocked/allowed hosts, etc.). */
  policy?: Omit<OutboundUrlPolicy, 'errorTag'>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB

function wrapBodyWithSizeCap(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  errorTag: string,
): ReadableStream<Uint8Array> | null {
  if (!body) return body;
  if (maxBytes <= 0) return body;
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
          controller.error(new Error(`${errorTag}: response body exceeded ${maxBytes} bytes`));
          return;
        }
        controller.enqueue(value);
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function composeSignal(
  caller: AbortSignal | null | undefined,
  timeoutMs: number,
): AbortSignal | undefined {
  if (timeoutMs <= 0) return caller ?? undefined;
  const t = AbortSignal.timeout(timeoutMs);
  if (!caller) return t;
  // AbortSignal.any is Node ≥20 — fall back to manual composition on older runtimes.
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([caller, t]);
  }
  const ctl = new AbortController();
  const onAbort = (reason: unknown) => ctl.abort(reason);
  if (caller.aborted) ctl.abort(caller.reason);
  else caller.addEventListener('abort', () => onAbort(caller.reason), { once: true });
  if (t.aborted) ctl.abort(t.reason);
  else t.addEventListener('abort', () => onAbort(t.reason), { once: true });
  return ctl.signal;
}

/**
 * Validate a URL with the shared SSRF guard. Streaming call sites that bypass
 * `hardenedFetch` (because they need to consume `body.getReader()` directly)
 * MUST still call this before opening the connection.
 *
 * Async — performs DNS resolution. Callers MUST await.
 */
export async function assertSafeForEgress(
  url: string,
  defaults: HardenedFetchDefaults,
): Promise<void> {
  await assertSafeOutboundUrl(url, { ...(defaults.policy ?? {}), errorTag: defaults.errorTag });
}

/**
 * The single hardened fetch. Per-package callers should `createHardenedFetch`
 * with their `errorTag` and per-package defaults rather than calling this raw
 * — that way every site shares one set of guards but messages stay readable.
 *
 * The third argument merges `HardenedFetchDefaults` (per-package identity,
 * static defaults) and `HardenedFetchOptions` (per-call overrides) into a
 * single object so every call site looks the same:
 *
 *     await hardenedFetch(url, init, { errorTag: 'tools-x', timeoutMs: 0 });
 */
export async function hardenedFetch(
  input: string,
  init?: RequestInit,
  opts: HardenedFetchOptions & HardenedFetchDefaults = { errorTag: 'hardened-fetch' },
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const enforceHttps = opts.enforceHttps ?? true;
  const errorTag = opts.errorTag;
  const policy: OutboundUrlPolicy = {
    ...(opts.policy ?? {}),
    errorTag,
  };

  if (enforceHttps) await assertSafeOutboundUrl(input, policy);

  // Phase 5 — attach a DNS-pinning dispatcher so the IP validated above is the
  // same IP undici connects to, closing the TOCTOU DNS-rebinding window.
  // Gracefully absent when undici is unavailable.
  const safeDispatcher = enforceHttps ? await createSafeDispatcher(policy) : undefined;

  const callerSignal = (init?.signal ?? null) as AbortSignal | null;
  const signal = composeSignal(callerSignal, timeoutMs);

  const composed: RequestInit & { redirect?: RequestRedirect; dispatcher?: unknown } = {
    ...(init ?? {}),
    redirect: opts.redirect ?? 'manual',
    ...(signal ? { signal } : {}),
    ...(safeDispatcher ?? {}),
  };

  const resp0 = await fetch(input, composed as RequestInit);
  const resp = enforceHttps
    ? await followRedirectsSafely(resp0, init, signal, policy)
    : resp0;

  if (maxBytes > 0) {
    const cl = resp.headers.get('content-length');
    if (cl) {
      const n = Number(cl);
      if (Number.isFinite(n) && n > maxBytes) {
        try { await resp.body?.cancel(); } catch { /* ignore */ }
        throw new Error(
          `${errorTag}: response Content-Length ${n} exceeds limit ${maxBytes}`,
        );
      }
    }
  }

  const cappedBody = wrapBodyWithSizeCap(resp.body, maxBytes, errorTag);
  return new Response(cappedBody, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}

/**
 * Bind a `hardenedFetch` closure with per-package defaults. The canonical entry
 * point for every `_fetch.ts` in the workspace. Returns:
 *   - `fetch(input, init, opts?)` — the standard hardened request/response path
 *   - `fetchStream(input, init)`  — SSRF + redirect re-validated, but NO outer
 *      timeout + NO size cap (use for SSE / NDJSON / chunked transfer)
 *   - `assertSafe(url)`           — just the SSRF guard for streaming call sites
 *      that bypass the wrapper entirely
 */
export function createHardenedFetch(defaults: HardenedFetchDefaults): {
  fetch: (input: string, init?: RequestInit, opts?: HardenedFetchOptions) => Promise<Response>;
  fetchStream: (input: string, init?: RequestInit) => Promise<Response>;
  assertSafe: (url: string) => Promise<void>;
} {
  const merge = (opts: HardenedFetchOptions = {}): HardenedFetchOptions & HardenedFetchDefaults => ({
    errorTag: defaults.errorTag,
    timeoutMs: opts.timeoutMs ?? defaults.timeoutMs,
    maxBytes: opts.maxBytes ?? defaults.maxBytes,
    ...(opts.enforceHttps !== undefined ? { enforceHttps: opts.enforceHttps } : {}),
    ...(opts.redirect !== undefined ? { redirect: opts.redirect } : {}),
    policy: { ...(defaults.policy ?? {}), ...(opts.policy ?? {}) },
  });
  return {
    fetch: (input, init, opts) => hardenedFetch(input, init, merge(opts)),
    fetchStream: (input, init) =>
      hardenedFetch(input, init, merge({ timeoutMs: 0, maxBytes: 0 })),
    assertSafe: (url) => assertSafeForEgress(url, defaults),
  };
}
