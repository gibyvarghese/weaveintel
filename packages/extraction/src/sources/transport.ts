// SPDX-License-Identifier: MIT
/**
 * The guarded transport every file source uses.
 *
 *   - https only (plain http only to a private endpoint an operator named);
 *   - only PUBLIC addresses: the hostname is resolved inside the connection's
 *     own DNS lookup hook and EVERY address is checked (`isPublicAddress`), so
 *     the address checked is the address connected to — no rebinding window;
 *   - redirects are followed by hand, each hop checked the same way, at most 5;
 *     credentials are dropped when a redirect leaves the origin;
 *   - size and time limits (Content-Length checked first, then while reading).
 *
 * `privateEndpoints` names exact host:port pairs that may be called although
 * private (an on-premises gateway, or a localhost stand-in in tests). A
 * hostname that merely RESOLVES to such an address is still refused.
 */

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { classifyAddress } from '@weaveintel/core';
import { SourceError } from './types.js';

export interface SourceRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

export interface SourceResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
  /** The URL that answered, after redirects. */
  readonly url: string;
}

export interface SourceTransport {
  send(request: SourceRequest, opts?: { readonly maxBytes?: number; readonly timeoutMs?: number }): Promise<SourceResponse>;
}

export type LookupFn = (hostname: string, cb: (err: Error | null, addresses: LookupAddress[]) => void) => void;

export interface GuardedTransportOptions {
  /** Largest body accepted. Default 50 MiB. */
  readonly maxBytes?: number;
  /** Whole-request timeout per hop. Default 60 s. */
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  /** Exact host:port pairs that may be called although private (and over http). */
  readonly privateEndpoints?: readonly { readonly host: string; readonly port: number }[];
  /** DNS lookup, for tests. Default `node:dns` lookup with all addresses. */
  readonly lookup?: LookupFn;
  /** Extra headers to drop on a cross-origin redirect (Authorization and Cookie always are). */
  readonly sensitiveHeaders?: readonly string[];
}

const defaultLookup: LookupFn = (hostname, cb) => dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => cb(err, addrs ?? []));

const portOf = (u: URL): number => (u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80);

export function createGuardedTransport(opts: GuardedTransportOptions = {}): SourceTransport {
  const maxRedirects = opts.maxRedirects ?? 5;
  const lookup = opts.lookup ?? defaultLookup;
  const sensitive = new Set(['authorization', 'cookie', 'proxy-authorization', ...(opts.sensitiveHeaders ?? []).map((h) => h.toLowerCase())]);
  const isAllowedPrivate = (u: URL): boolean =>
    (opts.privateEndpoints ?? []).some((e) => e.host.toLowerCase() === u.hostname.toLowerCase().replace(/^\[|\]$/g, '') && e.port === portOf(u));

  function check(u: URL): { allowedPrivate: boolean } {
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SourceError('bad_scheme', `Only https links can be fetched (${u.protocol} was given).`, 'POLICY_DENIED');
    if (u.username || u.password) throw new SourceError('credentials_in_url', 'Links with a user name or password in them are not fetched.', 'POLICY_DENIED');
    const allowedPrivate = isAllowedPrivate(u);
    if (u.protocol === 'http:' && !allowedPrivate) throw new SourceError('not_https', 'Only https links can be fetched.', 'POLICY_DENIED');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowedPrivate) {
      if (isIP(host) !== 0 && classifyAddress(host) !== 'public') {
        throw new SourceError('blocked_address', `The link points at a ${classifyAddress(host)} address, which is never fetched.`, 'POLICY_DENIED');
      }
      if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) {
        throw new SourceError('blocked_address', `The link points at an internal host name (${host}).`, 'POLICY_DENIED');
      }
    }
    return { allowedPrivate };
  }

  function once(u: URL, req: SourceRequest, headers: Record<string, string>, maxBytes: number, timeoutMs: number, allowedPrivate: boolean): Promise<{ res: IncomingMessage; bytes: Uint8Array }> {
    return new Promise((resolve, reject) => {
      const guardedLookup = (hostname: string, options: { all?: boolean } | number, cb: (...args: unknown[]) => void): void => {
        lookup(hostname, (err, addrs) => {
          if (err) return cb(err);
          if (addrs.length === 0) return cb(new SourceError('dns_failed', `${hostname} did not resolve.`, 'NOT_FOUND'));
          if (!allowedPrivate) {
            const bad = addrs.find((a) => classifyAddress(a.address) !== 'public');
            if (bad) return cb(new SourceError('blocked_address', `${hostname} resolves to a ${classifyAddress(bad.address)} address, which is never fetched.`, 'POLICY_DENIED'));
          }
          if (typeof options === 'object' && options.all) cb(null, addrs);
          else cb(null, addrs[0]!.address, addrs[0]!.family);
        });
      };
      const fn = u.protocol === 'https:' ? httpsRequest : httpRequest;
      const r = fn(u, { method: req.method, headers, lookup: guardedLookup as never, timeout: timeoutMs });
      const timer = setTimeout(() => r.destroy(new SourceError('timeout', `The fetch took longer than ${timeoutMs} ms.`, 'TIMEOUT', true)), timeoutMs);
      r.on('error', (e) => { clearTimeout(timer); reject(e instanceof SourceError ? e : new SourceError('network', `The fetch failed: ${e.message}`, 'PROVIDER_ERROR', true)); });
      r.on('response', (res) => {
        const isRedirect = (res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400 && res.headers.location;
        const cl = Number(res.headers['content-length'] ?? NaN);
        if (!isRedirect && Number.isFinite(cl) && cl > maxBytes) {
          clearTimeout(timer);
          res.destroy();
          return reject(new SourceError('too_large', `The file is ${cl} bytes; at most ${maxBytes} are accepted.`));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) {
            clearTimeout(timer);
            res.destroy();
            reject(new SourceError('too_large', `The file is larger than ${maxBytes} bytes.`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => { clearTimeout(timer); resolve({ res, bytes: new Uint8Array(Buffer.concat(chunks)) }); });
        res.on('error', (e) => { clearTimeout(timer); reject(new SourceError('network', `The fetch failed: ${e.message}`, 'PROVIDER_ERROR', true)); });
      });
      if (req.body !== undefined) r.write(req.body);
      r.end();
    });
  }

  return {
    async send(request, o) {
      const maxBytes = o?.maxBytes ?? opts.maxBytes ?? 50 * 1024 * 1024;
      const timeoutMs = o?.timeoutMs ?? opts.timeoutMs ?? 60_000;
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        throw new SourceError('bad_url', 'That is not a valid link.');
      }
      let headers: Record<string, string> = { 'user-agent': 'weaveintel-file-source', ...(request.headers ?? {}) };
      let current: SourceRequest = request;
      const origin = url.origin;
      for (let hop = 0; ; hop++) {
        const { allowedPrivate } = check(url);
        const { res, bytes } = await once(url, current, headers, maxBytes, timeoutMs, allowedPrivate);
        const status = res.statusCode ?? 0;
        const loc = res.headers.location;
        if (status >= 300 && status < 400 && loc) {
          if (hop >= maxRedirects) throw new SourceError('too_many_redirects', `More than ${maxRedirects} redirects.`);
          const next = new URL(loc, url);
          if (next.origin !== origin) {
            // Credentials never follow a redirect to another origin (e.g. a pre-signed download URL).
            headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !sensitive.has(k.toLowerCase())));
          }
          if (status === 303 || ((status === 301 || status === 302) && current.method === 'POST')) {
            current = { method: 'GET', url: next.toString() };
            delete headers['content-type'];
          } else {
            current = { ...current, url: next.toString() };
          }
          url = next;
          continue;
        }
        const flat: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) flat[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        return { status, headers: flat, bytes, url: url.toString() };
      }
    },
  };
}

/** Turn a non-2xx answer into a typed error naming the source. */
export function statusError(source: string, status: number, what: string): SourceError {
  if (status === 401) return new SourceError('auth_failed', `${source} refused the credentials for ${what}.`, 'AUTH_FAILED');
  if (status === 403) return new SourceError('forbidden', `${source} says this identity may not open ${what}.`, 'PERMISSION_DENIED');
  if (status === 404) return new SourceError('not_found', `${source} has no ${what} (or this identity cannot see it).`, 'NOT_FOUND');
  if (status === 429) return new SourceError('rate_limited', `${source} is limiting requests; try again shortly.`, 'RATE_LIMITED', true);
  return new SourceError('http_status', `${source} answered ${status} for ${what}.`, 'PROVIDER_ERROR', status >= 500);
}

export const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));
