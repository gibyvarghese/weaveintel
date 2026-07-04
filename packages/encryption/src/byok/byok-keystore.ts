/**
 * @weaveintel/encryption — BYOK keystore + HYOK proxy delegate.
 *
 * Three implementations of `ByokUnwrapDelegate`:
 *
 *   - `LocalByokKeystore`   — keeps an in-memory map of `tenantId -> privateKey`,
 *                              for dev / CI / break-glass cache.
 *   - `HttpHyokProxyDelegate` — POSTs ciphertext to a customer-controlled
 *                                HTTPS endpoint that returns `{ key: base64 }`.
 *   - `BreakGlassUnwrapDelegate` — pulls pre-staged unwrapped DEKs from a
 *                                    `BreakGlassGrantStore` for time-boxed,
 *                                    customer-approved offline access.
 *
 * Reusability: only `node:crypto` + sibling files. Hosts wire whichever
 * delegate they like through `bootstrapTenantEncryption({ kmsResolver })`.
 */

import { privateDecrypt, createPrivateKey, constants as cryptoConstants, type KeyObject } from 'node:crypto';
import { KmsUnavailableError } from '../errors.js';
import type { ByokUnwrapDelegate, ByokUnwrapRequest } from './byok-pem-provider.js';
import { assertSafeForEgress } from '@weaveintel/core';

// ── LocalByokKeystore ────────────────────────────────────────

export interface LocalByokKeystoreEntry {
  readonly tenantId: string;
  readonly privateKeyPem: string;
}

/**
 * In-memory keystore. Holds RSA private keys keyed by tenantId. Use for
 * dev/test ONLY — production deployments must use HYOK proxy or a
 * customer-controlled HSM bridge.
 */
export class LocalByokKeystore {
  readonly #keys = new Map<string, KeyObject>();

  add(entry: LocalByokKeystoreEntry): void {
    let priv: KeyObject;
    try {
      priv = createPrivateKey({ key: entry.privateKeyPem, format: 'pem' });
    } catch (err) {
      throw new KmsUnavailableError(`Local BYOK key parse failed: ${(err as Error).message}`);
    }
    if (priv.asymmetricKeyType !== 'rsa') {
      throw new KmsUnavailableError(`Local BYOK key must be RSA, got ${priv.asymmetricKeyType}`);
    }
    this.#keys.set(entry.tenantId, priv);
  }

  remove(tenantId: string): boolean {
    return this.#keys.delete(tenantId);
  }

  has(tenantId: string): boolean {
    return this.#keys.has(tenantId);
  }

  /** Returns a delegate bound to this keystore. */
  delegate(): ByokUnwrapDelegate {
    return async (req: ByokUnwrapRequest) => {
      const priv = this.#keys.get(req.tenantId);
      if (!priv) {
        throw new KmsUnavailableError(
          `LocalByokKeystore has no private key for tenant '${req.tenantId}'`,
        );
      }
      return privateDecrypt(
        { key: priv, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        req.ciphertext,
      );
    };
  }
}

// ── HttpHyokProxyDelegate ────────────────────────────────────

export interface HttpHyokProxyOptions {
  /** Customer-controlled HTTPS endpoint. POST `{ tenantId, rootKeyId, ciphertext_b64 }` → `{ key_b64 }`. */
  readonly endpoint: string;
  /** Optional bearer token for the proxy (`Authorization: Bearer ...`). */
  readonly bearerToken?: string;
  /**
   * Optional fetch override (test injection). Defaults to the global
   * `fetch` — Node ≥18 has it.
   */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). Default 5000. */
  readonly timeoutMs?: number;
  /** Extra headers (e.g. mTLS gateway hints). */
  readonly headers?: Record<string, string>;
}

/**
 * HTTP HYOK proxy. Each unwrap is a network round-trip. The customer's
 * endpoint MUST authenticate the caller and apply its own policy (rate
 * limits, key-usage attestation, signed-nonce challenge, etc.).
 *
 * Wire shape (deliberately minimal — customers can add fields under
 * `context` without breaking the contract):
 *
 *   POST endpoint
 *   {
 *     "tenantId":      "...",
 *     "rootKeyId":     "byok-pem:...",
 *     "ciphertext_b64":"base64",
 *     "context":       {...}
 *   }
 *   → 200 { "key_b64": "base64-of-32-bytes" }
 */
export function createHttpHyokProxyDelegate(opts: HttpHyokProxyOptions): ByokUnwrapDelegate {
  if (!opts.endpoint || !/^https:\/\//.test(opts.endpoint)) {
    throw new KmsUnavailableError('HYOK proxy endpoint must be an HTTPS URL');
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;

  // H-9 / CR-SSRF: Pre-resolve the SSRF check result at construction time so
  // any misconfigured endpoint is caught as early as possible. We store the
  // rejected-promise here and re-await it on the first unwrap call; after that
  // it resolves instantly from the cached promise value. This keeps the factory
  // function synchronous while still surfacing SSRF errors before production
  // traffic reaches the unwrap path.
  //
  // assertSafeForEgress blocks cloud metadata IPs (169.254.x.x, fd00::/8, etc.),
  // loopback addresses, RFC-1918 private ranges, and other SSRF-prone targets.
  // assertSafeForEgress requires a HardenedFetchDefaults object; we pass a
  // minimal defaults set with a descriptive errorTag for diagnostics.
  const ssrfCheck = assertSafeForEgress(opts.endpoint, { errorTag: 'hyok-proxy' });

  return async (req: ByokUnwrapRequest) => {
    // Re-await the pre-computed SSRF check. Throws KmsUnavailableError if the
    // endpoint resolves to a forbidden address; succeeds instantly on the
    // happy path because the Promise is already settled.
    await ssrfCheck.catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      throw new KmsUnavailableError(`HYOK proxy endpoint failed SSRF safety check: ${msg}`);
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(opts.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.bearerToken ? { authorization: `Bearer ${opts.bearerToken}` } : {}),
          ...(opts.headers ?? {}),
        },
        body: JSON.stringify({
          tenantId: req.tenantId,
          rootKeyId: req.rootKeyId,
          ciphertext_b64: req.ciphertext.toString('base64'),
          ...(req.context ? { context: req.context } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new KmsUnavailableError(`HYOK proxy returned ${res.status}: ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as { key_b64?: unknown };
      if (typeof body?.key_b64 !== 'string') {
        throw new KmsUnavailableError('HYOK proxy response missing key_b64');
      }
      const buf = Buffer.from(body.key_b64, 'base64');
      if (buf.length !== 32) {
        throw new KmsUnavailableError(`HYOK proxy returned ${buf.length}-byte key, expected 32`);
      }
      return buf;
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── BreakGlassUnwrapDelegate ─────────────────────────────────

/**
 * Pre-staged unwrap material indexed by ciphertext digest. The break-glass
 * flow (see `break-glass.ts`) writes entries here once a customer approves
 * a grant, and removes them on expiry / consumption.
 */
export interface BreakGlassGrantStore {
  /** Look up plaintext for a wrapped ciphertext. Returns null if no grant. */
  resolve(req: ByokUnwrapRequest): Promise<Buffer | null>;
}

/**
 * Wrap a `BreakGlassGrantStore` into a delegate. Useful when the customer
 * is offline and the operator needs a time-boxed, dual-approved unwrap to
 * run scheduled jobs (rotation, purge, etc.).
 */
export function createBreakGlassUnwrapDelegate(store: BreakGlassGrantStore): ByokUnwrapDelegate {
  return async (req) => {
    const buf = await store.resolve(req);
    if (!buf) {
      throw new KmsUnavailableError(
        `No active break-glass grant for tenant=${req.tenantId} rootKeyId=${req.rootKeyId}`,
      );
    }
    return buf;
  };
}

/**
 * Compose multiple delegates: try each in order until one succeeds. Any
 * `KmsUnavailableError` falls through; other errors bubble immediately.
 *
 * Typical pattern:
 *   `composeDelegates([breakGlassDelegate, hyokProxyDelegate])`
 *
 * → tries the local cached grant first (cheap, offline-capable), falls back
 * to a live HYOK round-trip if no grant is active.
 */
export function composeDelegates(delegates: readonly ByokUnwrapDelegate[]): ByokUnwrapDelegate {
  if (delegates.length === 0) {
    throw new KmsUnavailableError('composeDelegates requires at least one delegate');
  }
  return async (req) => {
    let lastErr: Error | null = null;
    for (const d of delegates) {
      try {
        return await d(req);
      } catch (err) {
        if (err instanceof KmsUnavailableError) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new KmsUnavailableError('All BYOK unwrap delegates failed');
  };
}
