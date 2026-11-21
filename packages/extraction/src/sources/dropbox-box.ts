// SPDX-License-Identifier: MIT
/**
 * Dropbox and Box.
 *
 * Dropbox: shared links through `sharing/get_shared_link_file`; ids and paths
 * (`dropbox:id:...`, `dropbox:/path`) through `files/download`; listing and
 * sync through `files/list_folder` and its cursor; members through
 * `sharing/list_file_members`. Identity: a user OAuth token, or a team token
 * with `Dropbox-API-Select-User` naming the member (service connection).
 *
 * Box: shared links through `/shared_items` (header `BoxApi: shared_link=...`);
 * ids as `box:{fileId}`; content through `/files/{id}/content` (a redirect to a
 * pre-signed download, where the token is NOT sent); collaborations as the
 * ACL. Identity: a user OAuth token, or a service account (CCG or JWT app)
 * that has been COLLABORATED on chosen folders.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { SourceTransport } from './transport.js';
import { json, statusError } from './transport.js';
import { SourceError, fetchedAs, type AclPrincipal, type FetchedFile, type FileSource, type SourceAcl, type SourceIdentity } from './types.js';

const needIdentity = (who: string, identity: SourceIdentity): Exclude<SourceIdentity, { kind: 'anonymous' }> => {
  if (identity.kind === 'anonymous') throw new SourceError('identity_required', `${who} needs a person or a service connection to fetch files.`, 'AUTH_FAILED');
  return identity;
};

// ─── Dropbox ─────────────────────────────────────────────────

export interface DropboxSourceOptions {
  readonly transport: SourceTransport;
  readonly apiBase?: string;
  readonly contentBase?: string;
  /** For a team (service) connection: the member to act as. */
  readonly selectUser?: string;
  readonly maxBytes?: number;
}

/** Dropbox-API-Arg must be ASCII: non-ASCII characters are escaped. */
const dropboxArg = (o: unknown): string => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function createDropboxSource(opts: DropboxSourceOptions): FileSource {
  const api = (opts.apiBase ?? 'https://api.dropboxapi.com/2').replace(/\/+$/, '');
  const content = (opts.contentBase ?? 'https://content.dropboxapi.com/2').replace(/\/+$/, '');
  async function headers(ctx: ExecutionContext, identity: SourceIdentity): Promise<Record<string, string>> {
    const id = needIdentity('Dropbox', identity);
    const tok = await id.tokenProvider.getToken(ctx, { audience: 'https://api.dropboxapi.com', scopes: ['files.content.read', 'sharing.read'] });
    return { authorization: `Bearer ${tok}`, ...(id.kind === 'service' && opts.selectUser ? { 'dropbox-api-select-user': opts.selectUser } : {}) };
  }
  async function rpc(ctx: ExecutionContext, identity: SourceIdentity, path: string, body: unknown, what: string): Promise<Record<string, unknown>> {
    const res = await opts.transport.send({ method: 'POST', url: `${api}${path}`, headers: { ...(await headers(ctx, identity)), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status < 200 || res.status >= 300) throw statusError('Dropbox', res.status, what);
    return json(res.bytes) as Record<string, unknown>;
  }
  const isShared = (ref: string): boolean => /^https:\/\/(www\.)?dropbox\.com\/(s|sh|scl)\//i.test(ref);
  return {
    id: 'dropbox',
    capabilities: { list: true, changes: true, acl: true, checkAccess: false },
    canResolve: (ref) => isShared(ref) || ref.startsWith('dropbox:'),
    async resolve(ctx, ref, identity): Promise<FetchedFile> {
      const h = await headers(ctx, identity);
      const shared = isShared(ref);
      const res = await opts.transport.send(
        {
          method: 'POST',
          url: `${content}${shared ? '/sharing/get_shared_link_file' : '/files/download'}`,
          headers: { ...h, 'dropbox-api-arg': dropboxArg(shared ? { url: ref } : { path: ref.slice('dropbox:'.length) }) },
        },
        { ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}) },
      );
      if (res.status < 200 || res.status >= 300) throw statusError('Dropbox', res.status, 'that file');
      const meta = JSON.parse(res.headers['dropbox-api-result'] ?? '{}') as { id?: string; name?: string; rev?: string; size?: number; path_display?: string };
      let acl: SourceAcl | undefined;
      if (meta.id) {
        try {
          const m = await rpc(ctx, identity, '/sharing/list_file_members', { file: meta.id, include_inherited: true }, 'its members');
          const principals: AclPrincipal[] = [];
          const role = (a: unknown): AclPrincipal['role'] => {
            const tag = (a as { '.tag'?: string } | undefined)?.['.tag'];
            return tag === 'owner' ? 'owner' : tag === 'editor' ? 'write' : 'read';
          };
          for (const u of (m['users'] as Array<{ user?: { account_id?: string; email?: string }; access_type?: unknown }>) ?? []) {
            principals.push({ kind: 'user', id: u.user?.account_id ?? u.user?.email ?? '', ...(u.user?.email ? { email: u.user.email } : {}), role: role(u.access_type) });
          }
          for (const g of (m['groups'] as Array<{ group?: { group_id?: string }; access_type?: unknown }>) ?? []) principals.push({ kind: 'group', id: g.group?.group_id ?? '', role: role(g.access_type) });
          acl = { principals, complete: !m['cursor'] };
        } catch {
          acl = undefined;
        }
      }
      return {
        source: 'dropbox',
        bytes: res.bytes,
        ...(meta.name ? { name: meta.name } : {}),
        size: res.bytes.length,
        ...(meta.rev ? { version: meta.rev } : {}),
        sourceUrl: shared ? ref : `https://www.dropbox.com/home${meta.path_display ?? ''}`,
        ...(meta.id ? { itemId: `dropbox:${meta.id}` } : {}),
        ...(acl ? { sourceAcl: acl } : {}),
        fetchedAs: fetchedAs(identity),
        fetchedAt: new Date().toISOString(),
      };
    },
    async list(ctx, folderRef, identity, cursor) {
      const body = cursor
        ? await rpc(ctx, identity, '/files/list_folder/continue', { cursor }, 'that folder')
        : await rpc(ctx, identity, '/files/list_folder', { path: folderRef.replace(/^dropbox:/, ''), limit: 500 }, 'that folder');
      const entries = (body['entries'] as Array<Record<string, unknown>>) ?? [];
      return {
        items: entries.map((e) => ({
          itemId: String(e['id'] ?? ''),
          name: String(e['name'] ?? ''),
          isFolder: e['.tag'] === 'folder',
          ...(typeof e['size'] === 'number' ? { size: e['size'] } : {}),
          ...(e['rev'] ? { version: String(e['rev']) } : {}),
          ref: `dropbox:${String(e['id'] ?? e['path_lower'] ?? '')}`,
        })),
        ...(body['has_more'] ? { next: String(body['cursor']) } : {}),
      };
    },
    /** `scope` is the folder path for the first call. */
    async changes(ctx, cursor, identity, scope) {
      if (!cursor) {
        const c = await rpc(ctx, identity, '/files/list_folder/get_latest_cursor', { path: scope ?? '', recursive: true }, 'a change cursor');
        return { changes: [], cursor: String(c['cursor'] ?? '') };
      }
      const changes: { itemId: string; ref: string; removed: boolean; name?: string; version?: string }[] = [];
      let cur = cursor;
      for (let page = 0; page < 1000; page++) {
        const body = await rpc(ctx, identity, '/files/list_folder/continue', { cursor: cur }, 'the change list');
        for (const e of (body['entries'] as Array<Record<string, unknown>>) ?? []) {
          if (e['.tag'] === 'folder') continue;
          changes.push({
            itemId: String(e['id'] ?? e['path_lower'] ?? ''),
            ref: `dropbox:${String(e['id'] ?? e['path_lower'] ?? '')}`,
            removed: e['.tag'] === 'deleted',
            ...(e['name'] ? { name: String(e['name']) } : {}),
            ...(e['rev'] ? { version: String(e['rev']) } : {}),
          });
        }
        cur = String(body['cursor'] ?? cur);
        if (!body['has_more']) return { changes, cursor: cur };
      }
      throw new SourceError('changes_incomplete', 'Dropbox did not finish the change list.', 'PROVIDER_ERROR', true);
    },
  };
}

// ─── Box ─────────────────────────────────────────────────────

export interface BoxSourceOptions {
  readonly transport: SourceTransport;
  readonly apiBase?: string;
  readonly maxBytes?: number;
}

export function normaliseBoxCollaborations(entries: readonly Record<string, unknown>[], sharedLink?: { access?: string } | null): SourceAcl {
  const principals: AclPrincipal[] = [];
  for (const c of entries) {
    if (c['status'] && c['status'] !== 'accepted') continue;
    const by = c['accessible_by'] as { type?: string; id?: string; login?: string } | undefined;
    const r = String(c['role'] ?? '');
    const role: AclPrincipal['role'] = r === 'owner' || r === 'co-owner' ? 'owner' : /editor|uploader/.test(r) ? 'write' : 'read';
    if (by?.type === 'user') principals.push({ kind: 'user', id: String(by.id ?? ''), ...(by.login ? { email: by.login } : {}), role });
    else if (by?.type === 'group') principals.push({ kind: 'group', id: String(by.id ?? ''), role });
  }
  if (sharedLink?.access === 'open') principals.push({ kind: 'anyone', id: 'anyone', role: 'read' });
  if (sharedLink?.access === 'company') principals.push({ kind: 'domain', id: 'company', role: 'read' });
  return { principals, inherited: true, complete: true };
}

export function createBoxSource(opts: BoxSourceOptions): FileSource {
  const api = (opts.apiBase ?? 'https://api.box.com/2.0').replace(/\/+$/, '');
  const isShared = (ref: string): boolean => /^https:\/\/([\w-]+\.)?(app\.)?box\.com\/(s|shared\/static)\//i.test(ref);
  async function auth(ctx: ExecutionContext, identity: SourceIdentity): Promise<Record<string, string>> {
    const id = needIdentity('Box', identity);
    return { authorization: `Bearer ${await id.tokenProvider.getToken(ctx, { audience: 'https://api.box.com', scopes: ['root_readonly'] })}` };
  }
  async function getJson(path: string, h: Record<string, string>, what: string): Promise<Record<string, unknown>> {
    const res = await opts.transport.send({ method: 'GET', url: `${api}${path}`, headers: h });
    if (res.status < 200 || res.status >= 300) throw statusError('Box', res.status, what);
    return json(res.bytes) as Record<string, unknown>;
  }
  return {
    id: 'box',
    capabilities: { list: true, changes: false, acl: true, checkAccess: true, notes: 'Changes need the enterprise events stream; not built here.' },
    canResolve: (ref) => isShared(ref) || ref.startsWith('box:'),
    async resolve(ctx, ref, identity): Promise<FetchedFile> {
      const h = await auth(ctx, identity);
      const file = isShared(ref)
        ? await getJson('/shared_items?fields=id,name,size,etag,sha1,type,shared_link', { ...h, boxapi: `shared_link=${ref}` }, 'that shared link')
        : await getJson(`/files/${encodeURIComponent(ref.slice('box:'.length))}?fields=id,name,size,etag,type,shared_link`, h, 'that file');
      if (file['type'] !== 'file') throw new SourceError('is_folder', 'That Box link is not a file.');
      const id = String(file['id']);
      const res = await opts.transport.send({ method: 'GET', url: `${api}/files/${encodeURIComponent(id)}/content`, headers: { ...h, ...(isShared(ref) ? { boxapi: `shared_link=${ref}` } : {}) } }, { ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}) });
      if (res.status < 200 || res.status >= 300) throw statusError('Box', res.status, 'the file content');
      let acl: SourceAcl | undefined;
      try {
        const c = await getJson(`/files/${encodeURIComponent(id)}/collaborations?fields=accessible_by,role,status`, h, 'its collaborations');
        acl = normaliseBoxCollaborations((c['entries'] as Record<string, unknown>[]) ?? [], file['shared_link'] as { access?: string } | null);
      } catch {
        acl = undefined;
      }
      return {
        source: 'box',
        bytes: res.bytes,
        ...(file['name'] ? { name: String(file['name']) } : {}),
        size: res.bytes.length,
        ...(file['etag'] ? { version: String(file['etag']) } : {}),
        sourceUrl: isShared(ref) ? ref : `https://app.box.com/file/${id}`,
        itemId: `box:${id}`,
        ...(acl ? { sourceAcl: acl } : {}),
        fetchedAs: fetchedAs(identity),
        fetchedAt: new Date().toISOString(),
      };
    },
    async list(ctx, folderRef, identity, cursor) {
      const h = await auth(ctx, identity);
      const folder = folderRef.replace(/^box:/, '') || '0';
      const offset = Number(cursor ?? 0);
      const body = await getJson(`/folders/${encodeURIComponent(folder)}/items?fields=id,name,size,etag,type&limit=200&offset=${offset}`, h, 'that folder');
      const entries = (body['entries'] as Array<Record<string, unknown>>) ?? [];
      const total = Number(body['total_count'] ?? 0);
      return {
        items: entries.map((e) => ({ itemId: String(e['id']), name: String(e['name'] ?? ''), isFolder: e['type'] === 'folder', ...(typeof e['size'] === 'number' ? { size: e['size'] } : {}), ...(e['etag'] ? { version: String(e['etag']) } : {}), ref: `box:${String(e['id'])}` })),
        ...(offset + entries.length < total ? { next: String(offset + entries.length) } : {}),
      };
    },
    async checkAccess(ctx, ref, user) {
      try {
        await getJson(`/files/${encodeURIComponent(ref.replace(/^box:/, ''))}?fields=id`, await auth(ctx, user), 'that file');
        return true;
      } catch (err) {
        if (err instanceof SourceError && (err.reason === 'forbidden' || err.reason === 'not_found')) return false;
        throw err;
      }
    },
  };
}
