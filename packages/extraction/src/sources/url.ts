// SPDX-License-Identifier: MIT
/**
 * Plain links (https) and iCloud share links.
 *
 * iCloud Drive: Apple publishes NO server API to read a person's iCloud Drive
 * (CloudKit Web Services only reach an app's own containers). So the only
 * supported paths are:
 *   1. a PUBLIC iCloud share link, fetched as a plain link — which works only
 *      when the link serves the file itself; most iCloud links serve a web page,
 *      and then the fetch is refused with a plain explanation;
 *   2. the person downloads the file from Files / Finder and uploads it.
 * Nothing here pretends otherwise.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { SourceTransport } from './transport.js';
import { statusError } from './transport.js';
import { SourceError, fetchedAs, type FetchedFile, type FileSource, type SourceIdentity, type TokenProvider } from './types.js';

export interface DomainCredential {
  /** Host suffix this applies to, e.g. "files.partner.example". */
  readonly domain: string;
  /** Sent as `Authorization: Bearer <token>`. */
  readonly tokenProvider?: TokenProvider;
  readonly audience?: string;
  readonly scopes?: readonly string[];
}

export interface UrlSourceOptions {
  readonly transport: SourceTransport;
  /** When set, only these host suffixes may be fetched (per-tenant data). */
  readonly allowDomains?: readonly string[];
  /** Per-domain credentials (data). Without one, links are fetched anonymously. */
  readonly credentials?: readonly DomainCredential[];
  readonly maxBytes?: number;
  /** Refs another source handles (Graph, Drive ...) are left to it. */
  readonly exclude?: (url: URL) => boolean;
}

const hostMatches = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

function nameFrom(url: URL, disposition: string | undefined): string | undefined {
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(disposition ?? '');
  if (star) {
    try { return decodeURIComponent(star[2]!.trim()); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition ?? '');
  if (plain) return plain[1]!.trim();
  const last = url.pathname.split('/').filter(Boolean).pop();
  return last ? decodeURIComponent(last) : undefined;
}

export function createUrlSource(opts: UrlSourceOptions): FileSource {
  return {
    id: 'url',
    capabilities: { list: false, changes: false, acl: false, checkAccess: false, notes: 'Plain https links; no listing, sync or permissions.' },
    canResolve(ref) {
      try {
        const u = new URL(ref);
        return (u.protocol === 'https:' || u.protocol === 'http:') && !(opts.exclude?.(u) ?? false);
      } catch {
        return false;
      }
    },
    async resolve(ctx: ExecutionContext, ref: string, identity: SourceIdentity): Promise<FetchedFile> {
      const url = new URL(ref);
      const host = url.hostname.toLowerCase();
      if (opts.allowDomains && !opts.allowDomains.some((d) => hostMatches(host, d.toLowerCase()))) {
        throw new SourceError('domain_not_allowed', `Links to ${host} are not on this workspace's allowed list.`, 'POLICY_DENIED');
      }
      const headers: Record<string, string> = {};
      const cred = opts.credentials?.find((c) => hostMatches(host, c.domain.toLowerCase()));
      if (cred?.tokenProvider && identity.kind !== 'anonymous') {
        headers['authorization'] = `Bearer ${await cred.tokenProvider.getToken(ctx, { audience: cred.audience ?? url.origin, scopes: cred.scopes ?? [] })}`;
      }
      const res = await opts.transport.send({ method: 'GET', url: url.toString(), headers }, { ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}) });
      if (res.status < 200 || res.status >= 300) throw statusError(host, res.status, 'that link');
      const final = new URL(res.url);
      return {
        source: 'url',
        bytes: res.bytes,
        ...(res.headers['content-type'] ? { declaredMimeType: res.headers['content-type'].split(';')[0]!.trim() } : {}),
        ...(nameFrom(final, res.headers['content-disposition']) ? { name: nameFrom(final, res.headers['content-disposition'])! } : {}),
        size: res.bytes.length,
        ...(res.headers['etag'] ? { version: res.headers['etag'] } : {}),
        sourceUrl: url.toString(),
        fetchedAs: cred && identity.kind !== 'anonymous' ? fetchedAs(identity) : { kind: 'anonymous' },
        fetchedAt: new Date().toISOString(),
      };
    },
  };
}

export const isICloudLink = (u: URL): boolean => /(^|\.)icloud\.com$/i.test(u.hostname);

/**
 * iCloud share links: tried as a plain public link. When iCloud answers with a
 * web page instead of the file (the usual case), the fetch is refused with a
 * plain explanation and the upload route.
 */
export function createICloudLinkSource(opts: { transport: SourceTransport; maxBytes?: number }): FileSource {
  const inner = createUrlSource({ transport: opts.transport, ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}) });
  return {
    id: 'icloud-link',
    capabilities: {
      list: false,
      changes: false,
      acl: false,
      checkAccess: false,
      notes: 'Apple offers no server API for iCloud Drive. Only a public share link that serves the file works; otherwise download it in Files or Finder and upload it.',
    },
    canResolve(ref) {
      try { return isICloudLink(new URL(ref)); } catch { return false; }
    },
    async resolve(ctx, ref) {
      const f = await inner.resolve(ctx, ref, { kind: 'anonymous' });
      const head = new TextDecoder().decode(f.bytes.subarray(0, 512)).trimStart().toLowerCase();
      if ((f.declaredMimeType ?? '').startsWith('text/html') || head.startsWith('<!doctype html') || head.startsWith('<html')) {
        throw new SourceError(
          'icloud_page_not_file',
          'This iCloud link opens a web page, not the file. Apple offers no way for other services to read iCloud Drive: download the file in Files or Finder and upload it here.',
          'INVALID_INPUT',
        );
      }
      return { ...f, source: 'icloud-link', notes: ['Fetched as a public iCloud share link.'] };
    },
  };
}
