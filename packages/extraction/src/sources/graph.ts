// SPDX-License-Identifier: MIT
/**
 * Microsoft Graph: OneDrive (personal and business) and SharePoint.
 *
 * - Any sharing link a person pastes (SharePoint, OneDrive for Business,
 *   1drv.ms, onedrive.live.com) becomes `/shares/u!{base64url(link)}/driveItem`.
 * - `graph:drives/{driveId}/items/{itemId}` names an item directly.
 * - Content: `.../content` (Graph answers with a redirect to a pre-signed
 *   download URL; the token is NOT sent there).
 * - Permissions: `.../permissions`, normalised (users, groups, organisation
 *   links as the domain, anonymous links as anyone).
 * - Sync: delta queries (`/drives/{id}/root/delta`, then the delta link).
 *
 * Identities:
 *   - user: a DELEGATED token for Graph (the host should get it by on-behalf-of
 *     exchange of the person's Entra sign-in; scopes Files.Read.All / Sites.Read.All);
 *   - service: an APP-ONLY token for an app granted **Sites.Selected** (an admin
 *     grants it specific sites). Never Sites.Read.All by default.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { SourceTransport } from './transport.js';
import { json, statusError } from './transport.js';
import { SourceError, fetchedAs, type AclPrincipal, type FetchedFile, type FileSource, type SourceAcl, type SourceIdentity } from './types.js';

export const GRAPH_AUDIENCE = 'https://graph.microsoft.com';
export const GRAPH_USER_SCOPES = ['Files.Read.All', 'Sites.Read.All'] as const;
/** App-only: the `.default` scope of an app registration granted Sites.Selected. */
export const GRAPH_SERVICE_SCOPES = ['https://graph.microsoft.com/.default'] as const;

/** Graph's share id for a sharing URL: "u!" + unpadded base64url of the URL. */
export function graphShareId(url: string): string {
  return `u!${Buffer.from(url, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
}

const SHARE_HOSTS = /(^|\.)(sharepoint\.com|sharepoint\.us|sharepoint-df\.com|1drv\.ms|onedrive\.live\.com|onedrive\.com)$/i;

export interface GraphSourceOptions {
  readonly transport: SourceTransport;
  /** Default https://graph.microsoft.com/v1.0 (a national cloud or a test stand-in may differ). */
  readonly baseUrl?: string;
  readonly maxBytes?: number;
}

interface DriveItem {
  id?: string;
  name?: string;
  size?: number;
  eTag?: string;
  cTag?: string;
  webUrl?: string;
  file?: { mimeType?: string };
  folder?: unknown;
  deleted?: unknown;
  parentReference?: { driveId?: string };
}

export function normaliseGraphPermissions(value: readonly Record<string, unknown>[]): SourceAcl {
  const principals: AclPrincipal[] = [];
  let inherited = false;
  const role = (roles: unknown): AclPrincipal['role'] => {
    const r = Array.isArray(roles) ? (roles as string[]) : [];
    return r.includes('owner') ? 'owner' : r.includes('write') ? 'write' : 'read';
  };
  for (const p of value) {
    if (p['inheritedFrom']) inherited = true;
    const link = p['link'] as { scope?: string } | undefined;
    if (link?.scope === 'anonymous') principals.push({ kind: 'anyone', id: 'anyone', role: role(p['roles']) });
    else if (link?.scope === 'organization') principals.push({ kind: 'domain', id: 'organization', role: role(p['roles']) });
    const grants = [p['grantedToV2'], ...((p['grantedToIdentitiesV2'] as unknown[]) ?? [])].filter(Boolean) as Array<Record<string, Record<string, string> | undefined>>;
    for (const g of grants) {
      const user = g['user'] ?? g['siteUser'];
      const group = g['group'] ?? g['siteGroup'];
      if (user?.['id'] || user?.['email']) principals.push({ kind: 'user', id: user['id'] ?? user['email']!, ...(user['email'] ? { email: user['email'] } : {}), role: role(p['roles']) });
      if (group?.['id']) principals.push({ kind: 'group', id: group['id'], ...(group['email'] ? { email: group['email'] } : {}), role: role(p['roles']) });
    }
  }
  return { principals, inherited, complete: true };
}

export function createGraphSource(opts: GraphSourceOptions): FileSource {
  const base = (opts.baseUrl ?? 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '');

  async function token(ctx: ExecutionContext, identity: SourceIdentity): Promise<string> {
    if (identity.kind === 'anonymous') throw new SourceError('identity_required', 'Microsoft Graph needs a person or a service connection to fetch files.', 'AUTH_FAILED');
    return identity.tokenProvider.getToken(ctx, { audience: GRAPH_AUDIENCE, scopes: identity.kind === 'user' ? GRAPH_USER_SCOPES : GRAPH_SERVICE_SCOPES });
  }

  /** The item path for a ref: `/shares/{id}/driveItem` or `/drives/{d}/items/{i}`. */
  function itemPath(ref: string): string {
    const m = /^graph:drives\/([^/]+)\/items\/([^/?#]+)$/.exec(ref);
    if (m) return `/drives/${encodeURIComponent(m[1]!)}/items/${encodeURIComponent(m[2]!)}`;
    return `/shares/${graphShareId(ref)}/driveItem`;
  }

  async function get(ctx: ExecutionContext, path: string, tok: string, what: string): Promise<{ status: number; body: unknown; bytes: Uint8Array }> {
    const res = await opts.transport.send({ method: 'GET', url: path.startsWith('http') ? path : `${base}${path}`, headers: { authorization: `Bearer ${tok}`, accept: 'application/json' } }, { ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}) });
    if (res.status < 200 || res.status >= 300) throw statusError('Microsoft Graph', res.status, what);
    return { status: res.status, body: res.headers['content-type']?.includes('json') ? json(res.bytes) : undefined, bytes: res.bytes };
  }

  const source: FileSource = {
    id: 'microsoft-graph',
    capabilities: { list: true, changes: true, acl: true, checkAccess: true, notes: 'OneDrive and SharePoint. Service connections use app-only Sites.Selected.' },
    canResolve(ref) {
      if (ref.startsWith('graph:')) return true;
      try { return SHARE_HOSTS.test(new URL(ref).hostname); } catch { return false; }
    },
    async resolve(ctx, ref, identity): Promise<FetchedFile> {
      const tok = await token(ctx, identity);
      const path = itemPath(ref);
      const meta = (await get(ctx, `${path}?$select=id,name,size,eTag,cTag,webUrl,file,folder,parentReference`, tok, 'that item')).body as DriveItem;
      if (meta.folder) throw new SourceError('is_folder', 'That link is a folder; list it instead.');
      const content = await get(ctx, `${path}/content`, tok, 'the file content');
      let acl: SourceAcl | undefined;
      try {
        const perms = (await get(ctx, `${path}/permissions`, tok, 'its permissions')).body as { value?: Record<string, unknown>[]; '@odata.nextLink'?: string };
        acl = { ...normaliseGraphPermissions(perms.value ?? []), complete: !perms['@odata.nextLink'] };
      } catch {
        acl = undefined; // Permissions may need more rights than reading does; the file is still returned.
      }
      const driveId = meta.parentReference?.driveId;
      return {
        source: 'microsoft-graph',
        bytes: content.bytes,
        ...(meta.file?.mimeType ? { declaredMimeType: meta.file.mimeType } : {}),
        ...(meta.name ? { name: meta.name } : {}),
        size: content.bytes.length,
        ...(meta.eTag ? { version: meta.eTag } : {}),
        sourceUrl: meta.webUrl ?? ref,
        ...(meta.id ? { itemId: driveId ? `graph:drives/${driveId}/items/${meta.id}` : meta.id } : {}),
        ...(acl ? { sourceAcl: acl } : {}),
        fetchedAs: fetchedAs(identity),
        fetchedAt: new Date().toISOString(),
      };
    },
    async list(ctx, folderRef, identity, cursor) {
      const tok = await token(ctx, identity);
      const body = (await get(ctx, cursor ?? `${itemPath(folderRef)}/children?$select=id,name,size,eTag,webUrl,file,folder,parentReference`, tok, 'that folder')).body as { value?: DriveItem[]; '@odata.nextLink'?: string };
      return {
        items: (body.value ?? []).map((i) => ({
          itemId: i.id ?? '',
          name: i.name ?? '',
          isFolder: Boolean(i.folder),
          ...(i.size !== undefined ? { size: i.size } : {}),
          ...(i.file?.mimeType ? { mimeType: i.file.mimeType } : {}),
          ...(i.eTag ? { version: i.eTag } : {}),
          ...(i.webUrl ? { sourceUrl: i.webUrl } : {}),
          ref: `graph:drives/${i.parentReference?.driveId ?? ''}/items/${i.id ?? ''}`,
        })),
        ...(body['@odata.nextLink'] ? { next: body['@odata.nextLink'] } : {}),
      };
    },
    /** `scope` is the drive id. Pass `cursor: null` first: the delta link returned is the cursor. */
    async changes(ctx, cursor, identity, scope) {
      const tok = await token(ctx, identity);
      if (!cursor && !scope) throw new SourceError('scope_required', 'A first delta query needs the drive id.');
      // First call: `token=latest` returns only a delta link (a starting point), not every item.
      let url: string = cursor ?? `/drives/${encodeURIComponent(scope!)}/root/delta?token=latest`;
      const changes: { itemId: string; ref: string; removed: boolean; name?: string; version?: string }[] = [];
      for (let page = 0; page < 1000; page++) {
        const body = (await get(ctx, url, tok, 'the change list')).body as { value?: DriveItem[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string };
        for (const i of body.value ?? []) {
          if (i.folder) continue;
          changes.push({
            itemId: i.id ?? '',
            ref: `graph:drives/${i.parentReference?.driveId ?? scope ?? ''}/items/${i.id ?? ''}`,
            removed: Boolean(i.deleted),
            ...(i.name ? { name: i.name } : {}),
            ...(i.eTag ? { version: i.eTag } : {}),
          });
        }
        if (body['@odata.deltaLink']) return { changes: cursor ? changes : [], cursor: body['@odata.deltaLink'] };
        if (!body['@odata.nextLink']) break;
        url = body['@odata.nextLink'];
      }
      throw new SourceError('delta_incomplete', 'Microsoft Graph did not finish the change list.', 'PROVIDER_ERROR', true);
    },
    async checkAccess(ctx, ref, user) {
      try {
        await get(ctx, `${itemPath(ref)}?$select=id`, await token(ctx, user), 'that item');
        return true;
      } catch (err) {
        if (err instanceof SourceError && (err.reason === 'forbidden' || err.reason === 'not_found')) return false;
        throw err;
      }
    },
  };
  return source;
}
