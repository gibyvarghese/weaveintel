// SPDX-License-Identifier: MIT
/**
 * File sources: where a file comes FROM (a link, OneDrive/SharePoint, Google
 * Drive, Dropbox, Box, an MCP server) and WHO fetched it.
 *
 * Every fetch is made as one identity, recorded on the result:
 *   - `user`: the person's own access, by a token the host obtains (ideally an
 *     on-behalf-of exchange of their sign-in), so they only ever get what they
 *     could open themselves;
 *   - `service`: a configured connection (app-only / service account) limited to
 *     the sites, drives or folders an admin chose;
 *   - `anonymous`: no credentials (public links only).
 *
 * Results are BYTES (never decoded strings), plus the name, size, version,
 * source URL and, where the API gives it, the source's permissions normalised.
 */

import type { ExecutionContext } from '@weaveintel/core';
import { WeaveIntelError, type ErrorCode } from '@weaveintel/core';

/** Gets an access token for one audience and set of scopes. The host decides how (OBO, refresh token, client credentials). */
export interface TokenProvider {
  getToken(ctx: ExecutionContext, request: { readonly audience: string; readonly scopes: readonly string[] }): Promise<string>;
}

export type SourceIdentity =
  | { readonly kind: 'user'; readonly userId: string; readonly tokenProvider: TokenProvider }
  | { readonly kind: 'service'; readonly connectionRef: string; readonly tokenProvider: TokenProvider }
  | { readonly kind: 'anonymous' };

/** Who fetched a file, without any secret. */
export type FetchedAs =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'service'; readonly connectionRef: string }
  | { readonly kind: 'anonymous' };

export const fetchedAs = (identity: SourceIdentity): FetchedAs =>
  identity.kind === 'user' ? { kind: 'user', userId: identity.userId } : identity.kind === 'service' ? { kind: 'service', connectionRef: identity.connectionRef } : { kind: 'anonymous' };

/** One principal that can read a file at its source. */
export interface AclPrincipal {
  readonly kind: 'user' | 'group' | 'domain' | 'anyone';
  /** The source's own id (user or group id, domain name, or "anyone"). */
  readonly id: string;
  readonly email?: string;
  readonly role?: 'read' | 'write' | 'owner';
}

/** The source's permissions on a file, normalised. Map principals to people in the host; unmapped = deny. */
export interface SourceAcl {
  readonly principals: readonly AclPrincipal[];
  /** True when some permissions are inherited from a folder, site or drive. */
  readonly inherited?: boolean;
  /** False when the API could not list every permission (paging, partial access). */
  readonly complete: boolean;
}

export interface FetchedFile {
  readonly source: string;
  readonly bytes: Uint8Array;
  /** The type the source declared (sniff the bytes before trusting it). */
  readonly declaredMimeType?: string;
  readonly name?: string;
  readonly size: number;
  /** ETag, revision or version, when the source has one. */
  readonly version?: string;
  /** A stable link to the item at its source. */
  readonly sourceUrl: string;
  /** The source's id for the item (drive item id, file id). */
  readonly itemId?: string;
  readonly sourceAcl?: SourceAcl;
  readonly fetchedAs: FetchedAs;
  readonly fetchedAt: string;
  /** e.g. "exported from Google Docs as DOCX". */
  readonly notes?: readonly string[];
}

export interface SourceListing {
  readonly itemId: string;
  readonly name: string;
  readonly isFolder: boolean;
  readonly size?: number;
  readonly mimeType?: string;
  readonly version?: string;
  readonly sourceUrl?: string;
  /** A ref `resolve` accepts. */
  readonly ref: string;
}

export interface SourceChange {
  readonly itemId: string;
  readonly ref: string;
  readonly removed: boolean;
  readonly name?: string;
  readonly version?: string;
}

/** Where a ref came from. Only refs a person gave or a configuration names are ever fetched. */
export type RefOrigin = 'user' | 'configured' | 'document';

export interface FileSource {
  readonly id: string;
  /** What this source can do, for a host's capability list. */
  readonly capabilities: { readonly list: boolean; readonly changes: boolean; readonly acl: boolean; readonly checkAccess: boolean; readonly notes?: string };
  /** Whether this source understands a ref (a URL or a `prefix:id` form). */
  canResolve(ref: string): boolean;
  resolve(ctx: ExecutionContext, ref: string, identity: SourceIdentity): Promise<FetchedFile>;
  list?(ctx: ExecutionContext, folderRef: string, identity: SourceIdentity, cursor?: string): Promise<{ readonly items: readonly SourceListing[]; readonly next?: string }>;
  /** Pass `null` to get a starting cursor (and no changes). */
  changes?(ctx: ExecutionContext, cursor: string | null, identity: SourceIdentity, scope?: string): Promise<{ readonly changes: readonly SourceChange[]; readonly cursor: string }>;
  /** A live check: can this PERSON open this item right now? */
  checkAccess?(ctx: ExecutionContext, ref: string, user: Extract<SourceIdentity, { kind: 'user' }>): Promise<boolean>;
}

/** A refused or failed fetch. `reason` is a stable machine code. */
export class SourceError extends WeaveIntelError {
  readonly reason: string;
  constructor(reason: string, message: string, code: ErrorCode = 'INVALID_INPUT', retryable = false) {
    super({ code, message, retryable, details: { reason } });
    this.name = 'SourceError';
    this.reason = reason;
  }
}
