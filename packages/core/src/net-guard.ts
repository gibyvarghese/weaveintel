/**
 * Shared outbound-network safety guard.
 *
 * Protects every package that calls `fetch()` from SSRF via:
 *   - HTTPS-only enforcement (loopback http:// allowed only when `allowLoopback`)
 *   - cloud-metadata hostname blocklist (AWS / GCP / Azure / link-local)
 *   - one address classifier for literals AND resolved addresses (`classifyAddress`,
 *     net-address.ts): only public unicast passes — loopback, RFC 1918, link-local,
 *     CGNAT 100.64/10, 0/8, 192.0.0.0/24, 198.18/15, documentation, multicast and
 *     reserved space are refused, and so are IPv6 ULA / link-local, NAT64
 *     64:ff9b::/96, IPv4-compatible ::/96 and IPv4-mapped ::ffff:0:0/96 forms,
 *     judged by the IPv4 they embed
 *   - DNS resolution of a hostname with EVERY address checked; a name that cannot
 *     be resolved is REFUSED (before 0.2.0 it was let through to "fail naturally",
 *     which made the guard fail open — security test S3-SSRF-2)
 *
 * Plus `followRedirectsSafely()`, which walks 3xx responses by hand
 * (`redirect:'manual'` on the initial fetch), re-validates each `Location`, and
 * CONNECTS each hop through `pinnedFetch` — a connect-time DNS lookup hook that
 * checks the address actually connected to — so no hop can be rebound between the
 * check and the connection (S3-SSRF-3). Credentials are dropped when a hop leaves
 * the origin.
 *
 * 0.2.0: `allowLoopback` defaults to FALSE. A caller that must reach this machine
 * (a local model server) says so.
 *
 * No vendor / runtime deps beyond `node:dns` + `node:net` (+ the optional `undici`
 * for connect-time pinning).
 */

import dns, { type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { classifyAddress, type AddressClass } from './net-address.js';

/** Resolve a hostname to every address it has (the shape of `dns.lookup(h, { all: true }, cb)`). */
export type OutboundLookup = (
  hostname: string,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export interface OutboundUrlPolicy {
  /** Allow http://localhost / 127.0.0.1 / ::1 (any loopback address). Default: false (0.2.0). */
  allowLoopback?: boolean;
  /** Allow any private/RFC1918/link-local destination. Default: false. */
  allowPrivateNetwork?: boolean;
  /** Extra hostnames to block (exact or suffix match). */
  blockedHostnames?: string[];
  /** Optional allow-list of hostnames (suffix match). */
  allowedHosts?: string[];
  /** Optional block-list of hostnames (suffix match). */
  blockedHosts?: string[];
  /** Tag inserted into error messages so callers can identify the package. Default: 'net'. */
  errorTag?: string;
  /**
   * The DNS lookup a hostname is resolved with (every address). Default: `node:dns`
   * `lookup` with `all: true`. The SAME function serves the pre-check and the
   * connect-time pin, so a test or a host with its own resolver passes one.
   */
  lookup?: OutboundLookup;
}

const DEFAULT_BLOCKED_HOSTNAMES = [
  'metadata.google.internal',
  'metadata.azure.internal',
  'metadata.aws.internal',
  'instance-data',
  '169.254.169.254',
  'fd00:ec2::254',
];

/** Request headers that carry a credential and never follow a redirect to another origin. */
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key', 'x-goog-api-key'];

const defaultLookup: OutboundLookup = (hostname, callback) => {
  dns.lookup(hostname, { all: true, verbatim: true }, callback);
};

const bare = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, '');

/** What a hostname (not an IP literal) is, before any lookup: a loopback name, a private name, or neither. */
function nameClass(host: string): AddressClass | undefined {
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (host.endsWith('.local') || host.endsWith('.internal')) return 'private';
  return undefined;
}

/** The class of a host that is refused under `policy`, or undefined when it may be reached. */
function refusedClass(cls: AddressClass, policy: OutboundUrlPolicy): AddressClass | undefined {
  if (cls === 'public') return undefined;
  if (cls === 'invalid') return cls;
  if (policy.allowPrivateNetwork === true) return undefined;
  if (cls === 'loopback' && policy.allowLoopback === true) return undefined;
  return cls;
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

function resolveAll(host: string, policy: OutboundUrlPolicy): Promise<LookupAddress[]> {
  const lookup = policy.lookup ?? defaultLookup;
  return new Promise((resolve, reject) => {
    lookup(host, (e, addresses) => (e ? reject(e) : resolve(addresses ?? [])));
  });
}

/**
 * Validate a URL before making any outbound request.
 *
 * Throws on any violation. Returns the parsed URL on success.
 *
 * MUST be awaited — a hostname is resolved and EVERY address is checked; a name
 * that does not resolve is refused.
 */
export async function assertSafeOutboundUrl(
  rawUrl: string,
  policy: OutboundUrlPolicy = {},
): Promise<URL> {
  const tag = policy.errorTag ?? 'net';
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

  const host = bare(parsed.hostname);
  const literal = isIP(host) !== 0;
  const cls: AddressClass | undefined = literal ? classifyAddress(host) : nameClass(host);

  // HTTPS enforcement: http:// only to this machine, and only when loopback is allowed.
  if (parsed.protocol === 'http:') {
    if (!(policy.allowLoopback === true && cls === 'loopback')) {
      throw err(tag, `refusing non-HTTPS request to "${host}" (only loopback may use http://, when allowed)`);
    }
  }

  // Hostname blocklist (cloud metadata + caller extras).
  const blockedHostnames = [...DEFAULT_BLOCKED_HOSTNAMES, ...(policy.blockedHostnames ?? [])];
  if (blockedHostnames.some((rule) => matches(host, rule))) {
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

  if (cls !== undefined) {
    const refused = refusedClass(cls, policy);
    if (refused !== undefined) throw err(tag, `${refused === 'loopback' ? 'loopback' : 'private network'} host is not allowed: ${host} (${refused})`);
    if (literal || allowPrivate || cls === 'loopback') return parsed;
  }
  if (allowPrivate) return parsed;

  // A hostname: resolve it and check EVERY address. A name that does not resolve is refused — the
  // connection would resolve it again, and "it did not resolve when we looked" proves nothing about then.
  let resolved: LookupAddress[];
  try {
    resolved = await resolveAll(host, policy);
  } catch (e) {
    const code = (e as { code?: string }).code ?? (e instanceof Error ? e.message : String(e));
    throw err(tag, `host ${host} could not be resolved (${code}) — refusing request`);
  }
  if (resolved.length === 0) throw err(tag, `host ${host} resolved to no address — refusing request`);
  for (const entry of resolved) {
    const refused = refusedClass(classifyAddress(entry.address), policy);
    if (refused !== undefined) {
      throw err(tag, `host ${host} resolved to ${refused === 'loopback' ? 'loopback' : 'private'} address ${entry.address} (${refused}) — refusing request`);
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
  const refused = refusedClass(classifyAddress(address), policy);
  if (refused !== undefined) {
    throw err(tag, `host resolved to ${refused === 'loopback' ? 'loopback' : 'private'} address ${address} (${refused}) — DNS rebinding detected`);
  }
  return address;
}

/**
 * The connect-time lookup hook: resolve with the policy's lookup and refuse the
 * connection unless EVERY address passes. Answers both callback shapes undici
 * asks for (`all: true`, or one address).
 */
export function pinnedLookup(policy: OutboundUrlPolicy): (hostname: string, options: unknown, callback: (...args: unknown[]) => void) => void {
  return (hostname, options, callback) => {
    const wantsAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    (policy.lookup ?? defaultLookup)(hostname, (e, addresses) => {
      if (e) return callback(e);
      try {
        if (!addresses || addresses.length === 0) throw err(policy.errorTag ?? 'net', `host ${hostname} resolved to no address`);
        for (const entry of addresses) validateResolvedAddress(entry.address, policy);
        if (wantsAll) return callback(null, addresses);
        const first = addresses[0]!;
        return callback(null, first.address, first.family);
      } catch (x) {
        return callback(x as NodeJS.ErrnoException);
      }
    });
  };
}

type UndiciModule = { Agent: new (opts: Record<string, unknown>) => unknown; fetch: typeof fetch };
let undiciModule: Promise<UndiciModule | undefined> | undefined;
const loadUndici = (): Promise<UndiciModule | undefined> => {
  undiciModule ??= (import('undici') as Promise<unknown>).then((m) => m as UndiciModule).catch(() => undefined);
  return undiciModule;
};

/**
 * Fetch with the connection pinned: the address undici connects to is resolved by
 * `pinnedLookup(policy)`, so it is the address that was checked. Without `undici`
 * installed this degrades to the global `fetch` (the pre-check still ran).
 *
 * The pinning dispatcher is `undici`'s own and must be driven by `undici`'s own
 * `fetch`: Node's global fetch is a different undici build and rejects a foreign
 * dispatcher (`UND_ERR_INVALID_ARG`).
 */
export async function pinnedFetch(
  url: string,
  init: RequestInit & { redirect?: RequestRedirect },
  policy: OutboundUrlPolicy = {},
): Promise<Response> {
  const undici = await loadUndici();
  if (undici === undefined) return fetch(url, init);
  const dispatcher = new undici.Agent({ connect: { lookup: pinnedLookup(policy) } });
  return undici.fetch(url, { ...init, dispatcher } as RequestInit);
}

/** The request headers to send to the next hop: without credentials when the hop leaves the origin. */
function headersForHop(init: RequestInit | undefined, from: string, to: string): HeadersInit | undefined {
  if (init?.headers === undefined) return undefined;
  if (new URL(from).origin === new URL(to).origin) return init.headers;
  const h = new Headers(init.headers);
  for (const name of CREDENTIAL_HEADERS) h.delete(name);
  return h;
}

/**
 * Follow 3xx redirects manually, re-validating each `Location` with
 * `assertSafeOutboundUrl` and connecting each hop through `pinnedFetch`. Pass the
 * response you got from a fetch invoked with `redirect: 'manual'`.
 *
 * Caps at `maxHops` (default 5). Returns the final non-redirect response.
 */
export async function followRedirectsSafely(
  initial: Response,
  init: RequestInit | undefined,
  signal: AbortSignal | undefined,
  policy: OutboundUrlPolicy & { maxHops?: number } = {},
  /** The URL `initial` answered for, when `initial.url` is empty (a hand-built Response). */
  startUrl?: string,
): Promise<Response> {
  const tag = policy.errorTag ?? 'net';
  const maxHops = policy.maxHops ?? 5;
  let current = initial;
  let currentUrl = initial.url || startUrl || 'about:blank';
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
      nextUrl = new URL(loc, currentUrl).toString();
    } catch {
      try { await current.body?.cancel(); } catch { /* ignore */ }
      throw err(tag, `invalid redirect Location "${loc}"`);
    }

    // Drain the redirect body before re-using the socket.
    try { await current.body?.cancel(); } catch { /* ignore */ }

    // Re-validate the next hop (this is the SSRF-bypass fix) …
    await assertSafeOutboundUrl(nextUrl, policy);

    // Per RFC: 303 always GET; 301/302/307/308 keep method (we keep method for safety).
    const initBase: RequestInit = { ...(init ?? {}) };
    if (current.status === 303) {
      initBase.method = 'GET';
      delete (initBase as { body?: BodyInit | null }).body;
    }
    const headers = currentUrl === 'about:blank' ? initBase.headers : headersForHop(initBase, currentUrl, nextUrl);

    const composed: RequestInit & { redirect?: RequestRedirect } = {
      ...initBase,
      ...(headers !== undefined ? { headers } : {}),
      redirect: 'manual',
      ...(signal ? { signal } : {}),
    };
    // … and connect to the address that was checked (S3-SSRF-3: hops used to go through the
    // global fetch, which resolves the name again on its own).
    current = await pinnedFetch(nextUrl, composed, policy);
    currentUrl = current.url || nextUrl;
    hops += 1;
  }

  return current;
}
