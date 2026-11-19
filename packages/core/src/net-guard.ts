/**
 * Shared outbound-network safety guard.
 *
 * Protects every package that calls `fetch()` from SSRF via:
 *   - HTTPS-only enforcement (loopback http:// allowed for local dev / tests)
 *   - cloud-metadata hostname blocklist (AWS / GCP / Azure / link-local)
 *   - private-network IP literal block (RFC1918 / loopback / link-local / ULA / IPv4-mapped-IPv6)
 *   - DNS resolution re-check (catches DNS rebinding to private IPs)
 *
 * Plus `followRedirectsSafely()` which manually walks 3xx responses
 * (`redirect:'manual'` on the initial fetch) and revalidates each `Location`
 * so a vendor cannot trick a hardened client into a metadata endpoint via a
 * crafted 302.
 *
 * No vendor / runtime deps beyond `node:dns` + `node:net`.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface OutboundUrlPolicy {
  /** Allow http://localhost / 127.0.0.1 / ::1. Default: true. */
  allowLoopback?: boolean;
  /** Allow any private/RFC1918/link-local destination. Default: false. */
  allowPrivateNetwork?: boolean;
  /**
   * Allow plaintext HTTP destinations. Default: false except for loopback.
   * Set only from trusted host configuration; credentials and payloads are not encrypted.
   */
  allowInsecureHttp?: boolean;
  /** Extra hostnames to block (exact or suffix match). */
  blockedHostnames?: string[];
  /** Optional allow-list of hostnames (suffix match). */
  allowedHosts?: string[];
  /** Optional block-list of hostnames (suffix match). */
  blockedHosts?: string[];
  /**
   * Allow cross-origin redirects only for GET/HEAD, with all caller-supplied headers stripped.
   * Default: false. Configure the destination URL directly for authenticated requests.
   */
  allowCrossOriginRedirects?: boolean;
  /** Tag inserted into error messages so callers can identify the package. Default: 'net'. */
  errorTag?: string;
}

const DEFAULT_BLOCKED_HOSTNAMES = [
  'metadata.google.internal',
  'metadata.azure.internal',
  'metadata.aws.internal',
  'instance-data',
  '169.254.169.254',
  'fd00:ec2::254',
];

function isLoopbackLiteral(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

function isPrivateIPv4(ip: string): boolean {
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (ip === '0.0.0.0') return true;
  const m = /^172\.(\d{1,3})\./.exec(ip);
  if (!m) return false;
  const o = Number.parseInt(m[1] ?? '0', 10);
  return o >= 16 && o <= 31;
}

function isPrivateIPv6(ip: string): boolean {
  const raw = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const n = new URL(`http://[${raw}]/`).hostname.slice(1, -1);
  if (n === '::1' || n === '::') return true;
  if (n.startsWith('fc') || n.startsWith('fd')) return true; // ULA
  if (/^fe[89ab]/.test(n)) return true; // link-local
  if (n.startsWith('::ffff:')) {
    const tail = n.slice('::ffff:'.length);
    // Dotted-quad form: ::ffff:10.0.0.1
    if (isIP(tail) === 4) return isPrivateIPv4(tail);
    // Compressed-hex form: ::ffff:a00:1 → reconstruct dotted-quad
    const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hexMatch) {
      const hi = Number.parseInt(hexMatch[1] ?? '0', 16);
      const lo = Number.parseInt(hexMatch[2] ?? '0', 16);
      const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isPrivateIPv4(dotted);
    }
  }
  return false;
}

function isPrivateHostLiteral(host: string): boolean {
  const n = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (n === 'localhost') return true;
  if (n.endsWith('.local') || n.endsWith('.internal')) return true;
  const kind = isIP(n);
  if (kind === 4) return isPrivateIPv4(n);
  if (kind === 6) return isPrivateIPv6(n);
  return false;
}

function isMetadataAddress(host: string): boolean {
  const raw = (host.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]) ?? '';
  const normalized = isIP(raw) === 6 ? new URL(`http://[${raw}]/`).hostname.slice(1, -1) : raw;
  return normalized === '169.254.169.254' || normalized === '::ffff:a9fe:a9fe' || normalized === 'fd00:ec2::254';
}

function matches(host: string, rule: string): boolean {
  const r = rule.toLowerCase().trim();
  if (!r) return false;
  if (host === r) return true;
  return host.endsWith(`.${r}`);
}

function err(tag: string, msg: string): Error {
  return new Error(`${tag}: ${msg}`);
}

/**
 * Validate a URL before making any outbound request.
 *
 * Throws on any violation. Returns the parsed URL on success.
 *
 * MUST be awaited — performs DNS resolution to catch DNS rebinding.
 */
export async function assertSafeOutboundUrl(
  rawUrl: string,
  policy: OutboundUrlPolicy = {},
): Promise<URL> {
  const tag = policy.errorTag ?? 'net';
  const allowLoopback = policy.allowLoopback ?? true;
  const allowPrivate = policy.allowPrivateNetwork ?? false;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw err(tag, `invalid URL "${rawUrl}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw err(tag, `protocol not allowed: ${parsed.protocol}`);
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // HTTPS enforcement (loopback http:// permitted when allowLoopback).
  if (parsed.protocol === 'http:') {
    if (!(allowLoopback && isLoopbackLiteral(host)) && policy.allowInsecureHttp !== true) {
      throw err(
        tag,
        `refusing non-HTTPS request to "${host}" (only loopback may use http://)`,
      );
    }
  }

  // Hostname blocklist (cloud metadata + caller extras).
  const blockedHostnames = [...DEFAULT_BLOCKED_HOSTNAMES, ...(policy.blockedHostnames ?? [])];
  if (isMetadataAddress(host) || blockedHostnames.some((rule) => matches(host, rule))) {
    throw err(tag, `blocked outbound host: ${host}`);
  }

  const blockedHosts = policy.blockedHosts ?? [];
  if (blockedHosts.length > 0 && blockedHosts.some((rule) => matches(host, rule))) {
    throw err(tag, `blocked outbound host: ${host}`);
  }

  const allowedHosts = policy.allowedHosts ?? [];
  if (allowedHosts.length > 0 && !allowedHosts.some((rule) => matches(host, rule))) {
    throw err(tag, `outbound host is not in allow list: ${host}`);
  }

  if (!allowPrivate && isPrivateHostLiteral(host) && !(allowLoopback && isLoopbackLiteral(host))) {
    throw err(tag, `private network host is not allowed: ${host}`);
  }
  // Always check resolved metadata addresses, even when private networks are enabled.
  if (isIP(host) === 0 && !isLoopbackLiteral(host)) {
    try {
      const resolved = await lookup(host, { all: true });
      for (const entry of resolved) validateResolvedAddress(entry.address, policy);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/ENOTFOUND|EAI_AGAIN|EAI_FAIL|ENODATA/i.test(msg)) throw e;
    }
  }
  return parsed;
}

/**
 * Validate a single already-resolved IP address against the SSRF policy.
 * Intended for use inside custom DNS lookup hooks (e.g. undici's
 * `connect.lookup`) so the check happens at connection time — closing the
 * TOCTOU window between `assertSafeOutboundUrl` (which resolves once at
 * validation time) and the actual `fetch` call (which re-resolves on its own).
 *
 * Throws with the same error shape as `assertSafeOutboundUrl` on violation.
 * Returns the address unchanged on success so callers can pass it through.
 */
export function validateResolvedAddress(address: string, policy: OutboundUrlPolicy = {}): string {
  const tag = policy.errorTag ?? 'net';
  if (isMetadataAddress(address)) throw err(tag, `blocked outbound address: ${address}`);
  const allowLoopback = policy.allowLoopback ?? true;
  const allowPrivate = policy.allowPrivateNetwork ?? false;
  if (!allowPrivate && isPrivateHostLiteral(address)) {
    if (!(allowLoopback && isLoopbackLiteral(address))) {
      throw err(tag, `host resolved to private address ${address} — DNS rebinding detected`);
    }
  }
  return address;
}

/**
 * Follow 3xx redirects manually, re-validating each `Location` with
 * `assertSafeOutboundUrl`. Pass the response you got from a fetch invoked
 * with `redirect: 'manual'`.
 *
 * Caps at `maxHops` (default 5). Cross-origin redirects are rejected by default.
 * Every hop uses the hardened transport; connection-time address validation requires undici.
 */
export async function followRedirectsSafely(
  initial: Response,
  init: RequestInit | undefined,
  signal: AbortSignal | undefined,
  policy: OutboundUrlPolicy & { maxHops?: number } = {},
  initialUrl?: string,
): Promise<Response> {
  const tag = policy.errorTag ?? 'net';
  const maxHops = policy.maxHops ?? 5;
  let current = initial;
  let currentUrl = initial.url || initialUrl || '';
  let requestInit: RequestInit = { ...(init ?? {}) };
  let hops = 0;

  while (current.status >= 300 && current.status < 400 && current.status !== 304) {
    if (hops >= maxHops) {
      try { await current.body?.cancel(); } catch { /* ignore */ }
      throw err(tag, `too many redirects (>${maxHops})`);
    }
    const loc = current.headers.get('location');
    if (!loc) return current; // 3xx without Location — let caller handle it.
    let nextUrl: string;
    try {
      nextUrl = new URL(loc, currentUrl || 'about:blank').toString();
    } catch {
      try { await current.body?.cancel(); } catch { /* ignore */ }
      throw err(tag, `invalid redirect Location "${loc}"`);
    }

    // Drain the redirect body before re-using the socket.
    try { await current.body?.cancel(); } catch { /* ignore */ }

    // Re-validate the next hop (this is the SSRF-bypass fix).
    await assertSafeOutboundUrl(nextUrl, policy);

    if (!currentUrl) throw err(tag, 'redirect source URL is unavailable');
    const crossOrigin = new URL(currentUrl).origin !== new URL(nextUrl).origin;
    if (crossOrigin) {
      if (!policy.allowCrossOriginRedirects) throw err(tag, 'cross-origin redirect is not allowed');
      const method = (requestInit.method ?? 'GET').toUpperCase();
      if ((method !== 'GET' && method !== 'HEAD') || requestInit.body != null) {
        throw err(tag, 'cross-origin redirect requires a bodyless GET or HEAD');
      }
      requestInit = { ...requestInit, headers: new Headers() };
    }

    // Per RFC: 303 becomes GET; other redirect statuses retain the original method.
    if (current.status === 303) {
      requestInit.method = (requestInit.method ?? 'GET').toUpperCase() === 'HEAD' ? 'HEAD' : 'GET';
      delete (requestInit as { body?: BodyInit | null }).body;
      const headers = new Headers(requestInit.headers);
      for (const name of ['content-length', 'content-type', 'transfer-encoding']) headers.delete(name);
      requestInit.headers = headers;
    }

    const composed: RequestInit & { redirect?: RequestRedirect } = {
      ...requestInit,
      redirect: 'manual',
      ...(signal ? { signal } : {}),
    };
    const { hardenedFetch } = await import('./hardened-fetch.js');
    current = await hardenedFetch(nextUrl, composed, {
      errorTag: tag,
      policy,
      redirect: 'manual',
      timeoutMs: 0,
      maxBytes: 0,
    });
    currentUrl = nextUrl;
    hops += 1;
  }

  return current;
}
