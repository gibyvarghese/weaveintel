// SPDX-License-Identifier: MIT
/**
 * Google Drive (My Drive and shared drives).
 *
 * - Refs: any Drive / Docs / Sheets / Slides link, or `gdrive:{fileId}`.
 * - Binary files: `files.get?alt=media`. Google Docs, Sheets, Slides and
 *   Drawings have no bytes of their own and are EXPORTED (Docs → DOCX,
 *   Sheets → XLSX, Slides and Drawings → PDF by default; configurable).
 * - Permissions: `files/{id}/permissions`, normalised (user, group, domain, anyone).
 * - Sync: `changes.getStartPageToken`, then `changes.list`.
 * - `supportsAllDrives=true` everywhere, so shared drives work.
 *
 * Identities:
 *   - user: the person's own OAuth token (`drive.readonly`);
 *   - service: a service account that is a MEMBER of the chosen shared drives or
 *     folders (preferred). Domain-wide delegation is the host's choice, made only
 *     when explicitly configured, and only with `drive.readonly`.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { SourceTransport } from './transport.js';
import { json, statusError } from './transport.js';
import { SourceError, fetchedAs, type AclPrincipal, type FetchedFile, type FileSource, type SourceAcl, type SourceIdentity } from './types.js';

export const DRIVE_AUDIENCE = 'https://www.googleapis.com';
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly'] as const;

export const DEFAULT_GOOGLE_EXPORTS: Readonly<Record<string, string>> = {
  'application/vnd.google-apps.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.drawing': 'application/pdf',
};

const EXPORT_NAMES: Readonly<Record<string, string>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/pdf': 'PDF',
  'text/plain': 'text',
  'text/csv': 'CSV',
};

/** The file id in a Drive / Docs link, or after `gdrive:`. */
export function driveFileId(ref: string): string | undefined {
  if (ref.startsWith('gdrive:')) return ref.slice('gdrive:'.length) || undefined;
  try {
    const u = new URL(ref);
    if (!/(^|\.)(drive|docs)\.google\.com$/i.test(u.hostname)) return undefined;
    const d = /\/d\/([A-Za-z0-9_-]{10,})/.exec(u.pathname);
    if (d) return d[1];
    const id = u.searchParams.get('id');
    return id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export function normaliseDrivePermissions(perms: readonly Record<string, unknown>[]): SourceAcl {
  const role = (r: unknown): AclPrincipal['role'] => (r === 'owner' || r === 'organizer' ? 'owner' : r === 'writer' || r === 'fileOrganizer' ? 'write' : 'read');
  let inherited = false;
  const principals: AclPrincipal[] = [];
  for (const p of perms) {
    const details = (p['permissionDetails'] as Array<{ inherited?: boolean }> | undefined) ?? [];
    if (details.some((d) => d.inherited)) inherited = true;
    const type = p['type'];
    if (type === 'anyone') principals.push({ kind: 'anyone', id: 'anyone', role: role(p['role']) });
    else if (type === 'domain') principals.push({ kind: 'domain', id: String(p['domain'] ?? ''), role: role(p['role']) });
    else if (type === 'user' || type === 'group') {
      const email = p['emailAddress'] as string | undefined;
      principals.push({ kind: type, id: String(p['id'] ?? email ?? ''), ...(email ? { email } : {}), role: role(p['role']) });
    }
  }
  return { principals, inherited, complete: true };
}

export interface GoogleDriveSourceOptions {
  readonly transport: SourceTransport;
  /** Default https://www.googleapis.com/drive/v3 */
  readonly baseUrl?: string;
  /** Google-native type → export type. */
  readonly exports?: Readonly<Record<string, string>>;
  readonly maxBytes?: number;
}

export function createGoogleDriveSource(opts: GoogleDriveSourceOptions): FileSource {
  const base = (opts.baseUrl ?? 'https://www.googleapis.com/drive/v3').replace(/\/+$/, '');
  const exportsMap = { ...DEFAULT_GOOGLE_EXPORTS, ...(opts.exports ?? {}) };

  async function token(ctx: ExecutionContext, identity: SourceIdentity): Promise<string> {
    if (identity.kind === 'anonymous') throw new SourceError('identity_required', 'Google Drive needs a person or a service account to fetch files.', 'AUTH_FAILED');
    return identity.tokenProvider.getToken(ctx, { audience: DRIVE_AUDIENCE, scopes: DRIVE_SCOPES });
  }
  async function get(path: string, tok: string, what: string, raw = false): Promise<{ body?: unknown; bytes: Uint8Array; type?: string }> {
    const res = await opts.transport.send({ method: 'GET', url: `${base}${path}`, headers: { authorization: `Bearer ${tok}` } }, { ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}) });
    if (res.status < 200 || res.status >= 300) throw statusError('Google Drive', res.status, what);
    return { ...(raw ? {} : { body: json(res.bytes) }), bytes: res.bytes, ...(res.headers['content-type'] ? { type: res.headers['content-type'] } : {}) };
  }
  const idOf = (ref: string): string => {
    const id = driveFileId(ref);
    if (!id) throw new SourceError('bad_ref', 'That is not a Google Drive link or file id.');
    return encodeURIComponent(id);
  };

  return {
    id: 'google-drive',
    capabilities: { list: true, changes: true, acl: true, checkAccess: true, notes: 'My Drive and shared drives; Docs, Sheets and Slides are exported.' },
    canResolve: (ref) => driveFileId(ref) !== undefined,
    async resolve(ctx, ref, identity): Promise<FetchedFile> {
      const tok = await token(ctx, identity);
      const id = idOf(ref);
      const meta = (await get(`/files/${id}?fields=id,name,mimeType,size,version,md5Checksum,webViewLink,driveId,trashed&supportsAllDrives=true`, tok, 'that file')).body as Record<string, string | boolean | undefined>;
      const mime = String(meta['mimeType'] ?? '');
      if (mime === 'application/vnd.google-apps.folder') throw new SourceError('is_folder', 'That link is a folder; list it instead.');
      const exportTo = mime.startsWith('application/vnd.google-apps.') ? exportsMap[mime] : undefined;
      if (mime.startsWith('application/vnd.google-apps.') && !exportTo) throw new SourceError('not_exportable', `Google files of type ${mime} cannot be exported.`);
      const content = exportTo
        ? await get(`/files/${id}/export?mimeType=${encodeURIComponent(exportTo)}`, tok, 'the export', true)
        : await get(`/files/${id}?alt=media&supportsAllDrives=true`, tok, 'the file content', true);
      let acl: SourceAcl | undefined;
      try {
        const p = (await get(`/files/${id}/permissions?fields=permissions(id,type,emailAddress,domain,role,permissionDetails),nextPageToken&supportsAllDrives=true`, tok, 'its permissions')).body as { permissions?: Record<string, unknown>[]; nextPageToken?: string };
        acl = { ...normaliseDrivePermissions(p.permissions ?? []), complete: !p.nextPageToken };
      } catch {
        acl = undefined;
      }
      return {
        source: 'google-drive',
        bytes: content.bytes,
        declaredMimeType: exportTo ?? mime,
        ...(meta['name'] ? { name: String(meta['name']) } : {}),
        size: content.bytes.length,
        ...(meta['version'] ? { version: String(meta['version']) } : {}),
        sourceUrl: String(meta['webViewLink'] ?? `https://drive.google.com/file/d/${decodeURIComponent(id)}/view`),
        itemId: `gdrive:${decodeURIComponent(id)}`,
        ...(acl ? { sourceAcl: acl } : {}),
        fetchedAs: fetchedAs(identity),
        fetchedAt: new Date().toISOString(),
        ...(exportTo ? { notes: [`Exported from ${mime.replace('application/vnd.google-apps.', 'Google ')} as ${EXPORT_NAMES[exportTo] ?? exportTo}.`] } : {}),
      };
    },
    async list(ctx, folderRef, identity, cursor) {
      const tok = await token(ctx, identity);
      const folder = decodeURIComponent(idOf(folderRef));
      const q = encodeURIComponent(`'${folder.replace(/'/g, "\\'")}' in parents and trashed = false`);
      const body = (await get(`/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,size,version,webViewLink)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=200${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''}`, tok, 'that folder')).body as { files?: Record<string, string>[]; nextPageToken?: string };
      return {
        items: (body.files ?? []).map((f) => ({
          itemId: f['id'] ?? '',
          name: f['name'] ?? '',
          isFolder: f['mimeType'] === 'application/vnd.google-apps.folder',
          ...(f['size'] ? { size: Number(f['size']) } : {}),
          ...(f['mimeType'] ? { mimeType: f['mimeType'] } : {}),
          ...(f['version'] ? { version: f['version'] } : {}),
          ...(f['webViewLink'] ? { sourceUrl: f['webViewLink'] } : {}),
          ref: `gdrive:${f['id'] ?? ''}`,
        })),
        ...(body.nextPageToken ? { next: body.nextPageToken } : {}),
      };
    },
    /** `scope` is a shared drive id (optional). */
    async changes(ctx, cursor, identity, scope) {
      const tok = await token(ctx, identity);
      const drive = scope ? `&driveId=${encodeURIComponent(scope)}` : '';
      if (!cursor) {
        const start = (await get(`/changes/startPageToken?supportsAllDrives=true${drive}`, tok, 'a change cursor')).body as { startPageToken?: string };
        return { changes: [], cursor: String(start.startPageToken ?? '') };
      }
      const changes: { itemId: string; ref: string; removed: boolean; name?: string; version?: string }[] = [];
      let token2: string = cursor;
      for (let page = 0; page < 1000; page++) {
        const body = (await get(`/changes?pageToken=${encodeURIComponent(token2)}&fields=nextPageToken,newStartPageToken,changes(fileId,removed,file(name,version,trashed))&supportsAllDrives=true&includeItemsFromAllDrives=true${drive}`, tok, 'the change list')).body as {
          changes?: Array<{ fileId?: string; removed?: boolean; file?: { name?: string; version?: string; trashed?: boolean } }>;
          nextPageToken?: string;
          newStartPageToken?: string;
        };
        for (const c of body.changes ?? []) {
          changes.push({
            itemId: c.fileId ?? '',
            ref: `gdrive:${c.fileId ?? ''}`,
            removed: Boolean(c.removed || c.file?.trashed),
            ...(c.file?.name ? { name: c.file.name } : {}),
            ...(c.file?.version ? { version: c.file.version } : {}),
          });
        }
        if (body.newStartPageToken) return { changes, cursor: body.newStartPageToken };
        if (!body.nextPageToken) break;
        token2 = body.nextPageToken;
      }
      throw new SourceError('changes_incomplete', 'Google Drive did not finish the change list.', 'PROVIDER_ERROR', true);
    },
    async checkAccess(ctx, ref, user) {
      try {
        await get(`/files/${idOf(ref)}?fields=id&supportsAllDrives=true`, await token(ctx, user), 'that file');
        return true;
      } catch (err) {
        if (err instanceof SourceError && (err.reason === 'forbidden' || err.reason === 'not_found')) return false;
        throw err;
      }
    },
  };
}
