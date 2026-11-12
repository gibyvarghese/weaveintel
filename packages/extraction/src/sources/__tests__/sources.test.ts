/**
 * File sources against localhost stand-in servers only. No real cloud call is
 * made: every adapter's base URL points at 127.0.0.1, which the guarded
 * transport allows only because each test names that exact host and port.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { weaveContext } from '@weaveintel/core';
import { createGuardedTransport, type SourceTransport } from '../transport.js';
import { createUrlSource, createICloudLinkSource } from '../url.js';
import { createGraphSource, graphShareId } from '../graph.js';
import { createGoogleDriveSource, driveFileId } from '../gdrive.js';
import { createBoxSource, createDropboxSource } from '../dropbox-box.js';
import { createMcpFileSource, createOnBehalfOfTokenProvider, createSourceResolver } from '../mcp-resolver.js';
import { SourceError, type SourceIdentity, type TokenProvider } from '../types.js';
import { createFileUnderstanding } from '../../files/service.js';
import { createModelFieldExtractor } from '../../files/engines.js';
import { createStandInModel } from '../../files/stand-ins.js';

const ctx = weaveContext({ tenantId: 't1' });

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
interface Stand { url: string; port: number; seen: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }>; routes: Map<string, Handler>; server: Server }

async function stand(): Promise<Stand> {
  const s: Partial<Stand> = { seen: [], routes: new Map() };
  s.server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      s.seen!.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const path = (req.url ?? '').split('?')[0]!;
      const h = s.routes!.get(`${req.method} ${path}`) ?? s.routes!.get(`${req.method} *`);
      if (!h) { res.statusCode = 404; res.end('{}'); return; }
      h(req, body, res);
    });
  });
  await new Promise<void>((r) => s.server!.listen(0, '127.0.0.1', r));
  s.port = (s.server.address() as AddressInfo).port;
  s.url = `http://127.0.0.1:${s.port}`;
  return s as Stand;
}
const sendJson = (res: ServerResponse, v: unknown, status = 200): void => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };

let A: Stand;
let B: Stand;
let transport: SourceTransport;
beforeAll(async () => {
  A = await stand();
  B = await stand();
  transport = createGuardedTransport({ privateEndpoints: [{ host: '127.0.0.1', port: A.port }, { host: '127.0.0.1', port: B.port }], maxBytes: 1024 * 1024 });
});
afterAll(() => { A.server.close(); B.server.close(); });

function tokens(): TokenProvider & { asked: Array<{ audience: string; scopes: readonly string[] }> } {
  const asked: Array<{ audience: string; scopes: readonly string[] }> = [];
  return { asked, async getToken(_c, r) { asked.push(r); return `tok-${r.scopes.join(',')}`; } };
}
const user = (tp: TokenProvider = tokens()): Extract<SourceIdentity, { kind: 'user' }> => ({ kind: 'user', userId: 'u-1', tokenProvider: tp });
const service = (tp: TokenProvider = tokens()): SourceIdentity => ({ kind: 'service', connectionRef: 'conn-sp-1', tokenProvider: tp });
const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(SourceError); return (e as SourceError).reason; }
  throw new Error('expected a SourceError');
};

describe('guarded transport', () => {
  it('fetches from an allowed endpoint and refuses everything private or plain-http otherwise', async () => {
    A.routes.set('GET /ok', (_q, _b, res) => res.end('hello'));
    expect(new TextDecoder().decode((await transport.send({ method: 'GET', url: `${A.url}/ok` })).bytes)).toBe('hello');
    const strict = createGuardedTransport();
    for (const url of ['https://127.0.0.1/', 'https://10.0.0.5/', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:a9fe:a9fe]/', 'https://0.0.0.0/', 'https://100.64.1.1/', 'https://localhost/', 'https://metadata.google.internal/']) {
      expect(await reasonOf(strict.send({ method: 'GET', url })), url).toBe('blocked_address');
    }
    expect(await reasonOf(strict.send({ method: 'GET', url: 'http://example.com/' }))).toBe('not_https');
    expect(await reasonOf(strict.send({ method: 'GET', url: 'https://u:p@example.com/' }))).toBe('credentials_in_url');
    expect(await reasonOf(strict.send({ method: 'GET', url: 'file:///etc/passwd' }))).toBe('bad_scheme');
    // A plain-http hop to the right host but another port is not the allowed endpoint.
    expect(await reasonOf(transport.send({ method: 'GET', url: "http://127.0.0.1:9/" }))).toBe('not_https');
  });

  it('checks every redirect hop: a redirect to a private or metadata address is refused', async () => {
    for (const target of ['https://169.254.169.254/latest/meta-data/', 'https://10.0.0.1/admin', 'https://[::1]:8080/']) {
      A.routes.set('GET /hop', (_q, _b, res) => { res.statusCode = 302; res.setHeader('location', target); res.end(); });
      expect(await reasonOf(transport.send({ method: 'GET', url: `${A.url}/hop` })), target).toBe('blocked_address');
    }
    A.routes.set('GET /loop', (_q, _b, res) => { res.statusCode = 302; res.setHeader('location', '/loop'); res.end(); });
    expect(await reasonOf(transport.send({ method: 'GET', url: `${A.url}/loop` }))).toBe('too_many_redirects');
  });

  it('refuses DNS rebinding: a public-looking name that resolves to a private address is never connected to', async () => {
    const rebinding = createGuardedTransport({ lookup: (_h, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]) });
    expect(await reasonOf(rebinding.send({ method: 'GET', url: 'https://files.example.com/a.pdf' }))).toBe('blocked_address');
    const mixed = createGuardedTransport({ lookup: (_h, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }]) });
    expect(await reasonOf(mixed.send({ method: 'GET', url: 'https://files.example.com/a.pdf' }))).toBe('blocked_address');
    // Even a name that resolves to an ALLOWED endpoint's address is refused: allowances are for the literal host.
    const named = createGuardedTransport({ privateEndpoints: [{ host: '127.0.0.1', port: A.port }], lookup: (_h, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]) });
    expect(await reasonOf(named.send({ method: 'GET', url: `https://evil.example:${A.port}/ok` }))).toBe('blocked_address');
  });

  it('refuses oversize bodies, declared or streamed', async () => {
    A.routes.set('GET /big', (_q, _b, res) => { res.setHeader('content-length', String(2 * 1024 * 1024)); res.end(Buffer.alloc(2 * 1024 * 1024)); });
    A.routes.set('GET /stream', (_q, _b, res) => { res.write(Buffer.alloc(700 * 1024)); res.end(Buffer.alloc(700 * 1024)); });
    expect(await reasonOf(transport.send({ method: 'GET', url: `${A.url}/big` }))).toBe('too_large');
    expect(await reasonOf(transport.send({ method: 'GET', url: `${A.url}/stream` }))).toBe('too_large');
  });

  it('drops credentials when a redirect leaves the origin', async () => {
    A.routes.set('GET /dl', (_q, _b, res) => { res.statusCode = 302; res.setHeader('location', `${B.url}/presigned`); res.end(); });
    B.routes.set('GET /presigned', (_q, _b, res) => res.end('bytes'));
    await transport.send({ method: 'GET', url: `${A.url}/dl`, headers: { authorization: 'Bearer secret', cookie: 'c=1' } });
    const hit = B.seen.find((s) => s.url === '/presigned')!;
    expect(hit.headers['authorization']).toBeUndefined();
    expect(hit.headers['cookie']).toBeUndefined();
    expect(A.seen.find((s) => s.url === '/dl')!.headers['authorization']).toBe('Bearer secret');
  });
});

describe('plain links and iCloud', () => {
  it('fetches bytes with name and type; allow-list and per-domain credentials are data', async () => {
    A.routes.set('GET /files/report.pdf', (_q, _b, res) => { res.setHeader('content-type', 'application/pdf'); res.setHeader('etag', '"v3"'); res.setHeader('content-disposition', "attachment; filename*=UTF-8''r%C3%A9port.pdf"); res.end(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0x00])); });
    const src = createUrlSource({ transport, credentials: [{ domain: '127.0.0.1', tokenProvider: tokens() }] });
    const f = await src.resolve(ctx, `${A.url}/files/report.pdf`, user());
    expect([...f.bytes]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0x00]);
    expect(f).toMatchObject({ name: 'réport.pdf', declaredMimeType: 'application/pdf', version: '"v3"', fetchedAs: { kind: 'user', userId: 'u-1' } });
    expect(A.seen.at(-1)!.headers['authorization']).toMatch(/^Bearer tok-/);
    const anon = await createUrlSource({ transport }).resolve(ctx, `${A.url}/files/report.pdf`, { kind: 'anonymous' });
    expect(anon.fetchedAs).toEqual({ kind: 'anonymous' });
    expect(A.seen.at(-1)!.headers['authorization']).toBeUndefined();
    expect(await reasonOf(createUrlSource({ transport, allowDomains: ['partner.example'] }).resolve(ctx, `${A.url}/files/report.pdf`, { kind: 'anonymous' }))).toBe('domain_not_allowed');
  });

  it('iCloud: a share link that serves a page is refused with the upload route, a file link works', async () => {
    const page: SourceTransport = { async send(r) { return { status: 200, headers: { 'content-type': 'text/html' }, bytes: new TextEncoder().encode('<!DOCTYPE html><html>iCloud</html>'), url: r.url }; } };
    const icloud = createICloudLinkSource({ transport: page });
    expect(icloud.canResolve('https://www.icloud.com/iclouddrive/0abcDEF#Report')).toBe(true);
    expect(icloud.capabilities.notes).toMatch(/no server API/);
    await expect(icloud.resolve(ctx, 'https://www.icloud.com/iclouddrive/0abc', { kind: 'anonymous' })).rejects.toThrow(/download the file in Files or Finder and upload it/);
    const file: SourceTransport = { async send(r) { return { status: 200, headers: { 'content-type': 'application/pdf' }, bytes: new TextEncoder().encode('%PDF-1.4'), url: r.url }; } };
    const ok = await createICloudLinkSource({ transport: file }).resolve(ctx, 'https://cvws.icloud-content.com/B/x/report.pdf', { kind: 'anonymous' });
    expect(ok.source).toBe('icloud-link');
  });
});

describe('Microsoft Graph (OneDrive, SharePoint)', () => {
  const link = 'https://contoso.sharepoint.com/:w:/s/finance/EaBcDeF?e=xyz';
  const share = graphShareId(link);
  beforeAll(() => {
    A.routes.set(`GET /v1.0/shares/${share}/driveItem`, (q, _b, res) => {
      if (q.headers.authorization === 'Bearer tok-bad') return sendJson(res, { error: 'accessDenied' }, 403);
      sendJson(res, { id: 'ITEM1', name: 'Q3.docx', size: 4, eTag: '"{1},5"', webUrl: link, file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, parentReference: { driveId: 'DRIVE1' } });
    });
    A.routes.set(`GET /v1.0/shares/${share}/driveItem/content`, (_q, _b, res) => { res.statusCode = 302; res.setHeader('location', `${B.url}/download/q3`); res.end(); });
    B.routes.set('GET /download/q3', (_q, _b, res) => res.end(Buffer.from('PK\u0003\u0004')));
    A.routes.set(`GET /v1.0/shares/${share}/driveItem/permissions`, (_q, _b, res) => sendJson(res, { value: [
      { roles: ['owner'], grantedToV2: { user: { id: 'aad-1', email: 'pat@contoso.com' } } },
      { roles: ['read'], grantedToV2: { group: { id: 'grp-fin', email: 'finance@contoso.com' } }, inheritedFrom: { path: '/sites/finance' } },
      { roles: ['read'], link: { scope: 'organization' } },
      { roles: ['read'], link: { scope: 'anonymous' } },
    ] }));
    A.routes.set('GET /v1.0/drives/DRIVE1/root/delta', (q, _b, res) => {
      if ((q.url ?? '').includes('token=latest')) return sendJson(res, { value: [], '@odata.deltaLink': `${A.url}/v1.0/drives/DRIVE1/root/delta?token=T1` });
      sendJson(res, { value: [{ id: 'ITEM1', name: 'Q3.docx', eTag: '"{1},6"', file: {}, parentReference: { driveId: 'DRIVE1' } }, { id: 'ITEM2', deleted: { state: 'deleted' }, parentReference: { driveId: 'DRIVE1' } }, { id: 'F1', folder: {} }], '@odata.deltaLink': `${A.url}/v1.0/drives/DRIVE1/root/delta?token=T2` });
    });
  });

  it('resolves a pasted SharePoint link to bytes, with the ACL normalised and the token kept off the download host', async () => {
    const tp = tokens();
    const graph = createGraphSource({ transport, baseUrl: `${A.url}/v1.0` });
    expect(graph.canResolve(link)).toBe(true);
    expect(graph.canResolve('https://1drv.ms/w/s!Abc')).toBe(true);
    const f = await graph.resolve(ctx, link, user(tp));
    expect(new TextDecoder().decode(f.bytes)).toBe('PK\u0003\u0004');
    expect(f).toMatchObject({ name: 'Q3.docx', version: '"{1},5"', itemId: 'graph:drives/DRIVE1/items/ITEM1', fetchedAs: { kind: 'user', userId: 'u-1' } });
    expect(f.sourceAcl).toEqual({
      principals: [
        { kind: 'user', id: 'aad-1', email: 'pat@contoso.com', role: 'owner' },
        { kind: 'group', id: 'grp-fin', email: 'finance@contoso.com', role: 'read' },
        { kind: 'domain', id: 'organization', role: 'read' },
        { kind: 'anyone', id: 'anyone', role: 'read' },
      ],
      inherited: true,
      complete: true,
    });
    expect(tp.asked[0]).toEqual({ audience: 'https://graph.microsoft.com', scopes: ['Files.Read.All', 'Sites.Read.All'] });
    expect(B.seen.find((s) => s.url === '/download/q3')!.headers['authorization']).toBeUndefined();
  });

  it('records the service identity and asks for an app-only token (Sites.Selected app)', async () => {
    const tp = tokens();
    const f = await createGraphSource({ transport, baseUrl: `${A.url}/v1.0` }).resolve(ctx, link, service(tp));
    expect(f.fetchedAs).toEqual({ kind: 'service', connectionRef: 'conn-sp-1' });
    expect(tp.asked[0]!.scopes).toEqual(['https://graph.microsoft.com/.default']);
  });

  it('delta: a starting cursor first, then changes with removals; live access check per person', async () => {
    const graph = createGraphSource({ transport, baseUrl: `${A.url}/v1.0` });
    const first = await graph.changes!(ctx, null, service(), 'DRIVE1');
    expect(first.changes).toEqual([]);
    const next = await graph.changes!(ctx, first.cursor, service());
    expect(next.changes).toEqual([
      { itemId: 'ITEM1', ref: 'graph:drives/DRIVE1/items/ITEM1', removed: false, name: 'Q3.docx', version: '"{1},6"' },
      { itemId: 'ITEM2', ref: 'graph:drives/DRIVE1/items/ITEM2', removed: true },
    ]);
    expect(next.cursor).toMatch(/token=T2$/);
    expect(await graph.checkAccess!(ctx, link, user())).toBe(true);
    expect(await graph.checkAccess!(ctx, link, user({ getToken: async () => 'tok-bad' }))).toBe(false);
    expect(await reasonOf(graph.resolve(ctx, link, { kind: 'anonymous' }))).toBe('identity_required');
  });
});

describe('Google Drive', () => {
  beforeAll(() => {
    A.routes.set('GET /drive/v3/files/DOC123456789', (q, _b, res) => {
      if ((q.url ?? '').includes('fields=id&')) return sendJson(res, { id: 'DOC123456789' });
      sendJson(res, { id: 'DOC123456789', name: 'Plan', mimeType: 'application/vnd.google-apps.document', version: '42', webViewLink: 'https://docs.google.com/document/d/DOC123456789/edit' });
    });
    A.routes.set('GET /drive/v3/files/DOC123456789/export', (_q, _b, res) => res.end(Buffer.from('PK-docx')));
    A.routes.set('GET /drive/v3/files/BIN123456789', (q, _b, res) => {
      if ((q.url ?? '').includes('alt=media')) return res.end(Buffer.from([0xff, 0xd8, 0xff, 0x00]));
      sendJson(res, { id: 'BIN123456789', name: 'photo.jpg', mimeType: 'image/jpeg', size: '4', version: '7' });
    });
    for (const id of ['DOC123456789', 'BIN123456789']) {
      A.routes.set(`GET /drive/v3/files/${id}/permissions`, (_q, _b, res) => sendJson(res, { permissions: [
        { id: 'p1', type: 'user', emailAddress: 'sam@example.com', role: 'writer' },
        { id: 'p2', type: 'domain', domain: 'example.com', role: 'reader', permissionDetails: [{ inherited: true }] },
        { id: 'anyoneWithLink', type: 'anyone', role: 'reader' },
      ] }));
    }
    A.routes.set('GET /drive/v3/changes/startPageToken', (_q, _b, res) => sendJson(res, { startPageToken: '100' }));
    A.routes.set('GET /drive/v3/changes', (_q, _b, res) => sendJson(res, { changes: [{ fileId: 'BIN123456789', file: { name: 'photo.jpg', version: '8' } }, { fileId: 'GONE12345678', removed: true }], newStartPageToken: '101' }));
  });

  it('exports Docs as DOCX and downloads binaries as they are, with the ACL', async () => {
    const drive = createGoogleDriveSource({ transport, baseUrl: `${A.url}/drive/v3` });
    expect(driveFileId('https://docs.google.com/document/d/DOC123456789/edit')).toBe('DOC123456789');
    expect(driveFileId('https://drive.google.com/open?id=BIN123456789')).toBe('BIN123456789');
    const doc = await drive.resolve(ctx, 'https://docs.google.com/document/d/DOC123456789/edit', user());
    expect(doc).toMatchObject({ declaredMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'Plan', notes: ['Exported from Google document as DOCX.'] });
    expect(A.seen.find((s) => s.url.startsWith('/drive/v3/files/DOC123456789/export'))!.url).toContain(encodeURIComponent('application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
    const bin = await drive.resolve(ctx, 'gdrive:BIN123456789', service());
    expect([...bin.bytes]).toEqual([0xff, 0xd8, 0xff, 0x00]);
    expect(bin.fetchedAs).toEqual({ kind: 'service', connectionRef: 'conn-sp-1' });
    expect(bin.sourceAcl).toEqual({ principals: [
      { kind: 'user', id: 'p1', email: 'sam@example.com', role: 'write' },
      { kind: 'domain', id: 'example.com', role: 'read' },
      { kind: 'anyone', id: 'anyone', role: 'read' },
    ], inherited: true, complete: true });
    expect(A.seen.filter((s) => s.url.startsWith('/drive/v3/files/BIN')).every((s) => s.url.includes('supportsAllDrives=true'))).toBe(true);
  });

  it('changes: start token, then changes with removals', async () => {
    const drive = createGoogleDriveSource({ transport, baseUrl: `${A.url}/drive/v3` });
    const start = await drive.changes!(ctx, null, service());
    expect(start).toEqual({ changes: [], cursor: '100' });
    const next = await drive.changes!(ctx, '100', service());
    expect(next.changes.map((c) => [c.itemId, c.removed])).toEqual([['BIN123456789', false], ['GONE12345678', true]]);
    expect(next.cursor).toBe('101');
  });
});

describe('Dropbox and Box', () => {
  it('Dropbox shared link through get_shared_link_file, with members', async () => {
    A.routes.set('POST /2/sharing/get_shared_link_file', (q, _b, res) => {
      res.setHeader('dropbox-api-result', JSON.stringify({ id: 'id:abc', name: 'notes.txt', rev: 'r9', size: 5 }));
      res.end(JSON.parse(String(q.headers['dropbox-api-arg'])).url.includes('dropbox.com/s/') ? 'hello' : 'wrong');
    });
    A.routes.set('POST /2/sharing/list_file_members', (_q, _b, res) => sendJson(res, { users: [{ user: { account_id: 'dbid:1', email: 'lee@example.com' }, access_type: { '.tag': 'owner' } }], groups: [] }));
    const dbx = createDropboxSource({ transport, apiBase: `${A.url}/2`, contentBase: `${A.url}/2` });
    const f = await dbx.resolve(ctx, 'https://www.dropbox.com/s/abc123/notes.txt?dl=0', user());
    expect(new TextDecoder().decode(f.bytes)).toBe('hello');
    expect(f).toMatchObject({ name: 'notes.txt', version: 'r9', itemId: 'dropbox:id:abc', sourceAcl: { principals: [{ kind: 'user', id: 'dbid:1', email: 'lee@example.com', role: 'owner' }], complete: true } });
  });

  it('Box shared link through shared_items, content via a redirect without the token', async () => {
    A.routes.set('GET /2.0/shared_items', (q, _b, res) => sendJson(res, String(q.headers['boxapi']).startsWith('shared_link=https://app.box.com/s/') ? { type: 'file', id: '555', name: 'spec.pdf', etag: '3', shared_link: { access: 'company' } } : {}, 200));
    A.routes.set('GET /2.0/files/555/content', (_q, _b, res) => { res.statusCode = 302; res.setHeader('location', `${B.url}/box/dl`); res.end(); });
    B.routes.set('GET /box/dl', (_q, _b, res) => res.end('%PDF-'));
    A.routes.set('GET /2.0/files/555/collaborations', (_q, _b, res) => sendJson(res, { entries: [{ accessible_by: { type: 'group', id: 'g7' }, role: 'viewer', status: 'accepted' }, { accessible_by: { type: 'user', id: 'u9', login: 'x@y.z' }, role: 'editor', status: 'pending' }] }));
    const box = createBoxSource({ transport, apiBase: `${A.url}/2.0` });
    const f = await box.resolve(ctx, 'https://app.box.com/s/abcdef', service());
    expect(new TextDecoder().decode(f.bytes)).toBe('%PDF-');
    expect(f.sourceAcl!.principals).toEqual([{ kind: 'group', id: 'g7', role: 'read' }, { kind: 'domain', id: 'company', role: 'read' }]);
    expect(B.seen.find((s) => s.url === '/box/dl')!.headers['authorization']).toBeUndefined();
  });
});

describe('MCP source and the resolver', () => {
  it('maps a ref into the configured tool arguments and keeps bytes intact', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = { async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { content: [{ type: 'resource' as const, resource: { uri: 'sharefile://docs/a.pdf', mimeType: 'application/pdf', blob: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xfe]).toString('base64') } }] };
    } };
    const mcp = createMcpFileSource(client, { id: 'mcp:sharefile', refPrefix: 'sharefile:', tool: 'read_file', args: { path: '{ref}', encoding: 'base64', options: { meta: ['{ref}'] } } });
    const f = await mcp.resolve(ctx, 'sharefile:/docs/a.pdf', user());
    expect(calls[0]).toEqual({ name: 'read_file', args: { path: '/docs/a.pdf', encoding: 'base64', options: { meta: ['/docs/a.pdf'] } } });
    expect([...f.bytes]).toEqual([0x25, 0x50, 0x44, 0x46, 0x00, 0xfe]);
    expect(f).toMatchObject({ source: 'mcp:sharefile', sourceUrl: 'sharefile://docs/a.pdf', fetchedAs: { kind: 'user', userId: 'u-1' } });
    const textOnly = createMcpFileSource({ async callTool() { return { content: [{ type: 'text' as const, text: 'not bytes' }] }; } }, { id: 'mcp:x', refPrefix: 'x:', tool: 't', args: {} });
    expect(await reasonOf(textOnly.resolve(ctx, 'x:1', user()))).toBe('mcp_no_bytes');
  });

  it('routes refs to the right source and NEVER fetches a link found inside a document', async () => {
    const graph = createGraphSource({ transport, baseUrl: `${A.url}/v1.0` });
    const resolver = createSourceResolver([graph, createGoogleDriveSource({ transport }), createUrlSource({ transport })]);
    expect(resolver.sourceFor('https://contoso.sharepoint.com/:x:/r/a')?.id).toBe('microsoft-graph');
    expect(resolver.sourceFor('https://docs.google.com/spreadsheets/d/SHEET1234567/edit')?.id).toBe('google-drive');
    expect(resolver.sourceFor('https://example.com/a.pdf')?.id).toBe('url');
    expect(await reasonOf(resolver.resolve(ctx, 'https://example.com/a.pdf', { kind: 'anonymous' }, 'document'))).toBe('origin_not_allowed');
    expect(resolver.capabilities().map((c) => c.id)).toEqual(['microsoft-graph', 'google-drive', 'url']);

    // Understanding a file whose text and extracted value hold a URL makes no network request at all.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const before = A.seen.length;
    const model = createStandInModel(() => JSON.stringify({ link: { value: `${A.url}/ok`, quote: `${A.url}/ok`, page: 1, confidence: 0.9 } }));
    const fu = createFileUnderstanding({ pipelineVersion: 'p', extractor: createModelFieldExtractor(model) });
    const r = await fu.understand(ctx, { bytes: new TextEncoder().encode(`See ${A.url}/ok and https://example.com/payload`) }, { tenantId: 't1', fields: [{ name: 'link', type: 'string' }] });
    expect(r.values![0]!.value).toBe(`${A.url}/ok`);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(A.seen.length).toBe(before);
    fetchSpy.mockRestore();
  });

  it('on-behalf-of token provider caches per audience and scopes', async () => {
    let n = 0;
    let t = 0;
    const obo = createOnBehalfOfTokenProvider({ assertion: async () => 'user-assertion', exchange: async () => ({ accessToken: `t${++n}`, expiresInSeconds: 3600 }), now: () => t });
    expect(await obo.getToken(ctx, { audience: 'g', scopes: ['a', 'b'] })).toBe('t1');
    expect(await obo.getToken(ctx, { audience: 'g', scopes: ['b', 'a'] })).toBe('t1');
    t = 3600_000;
    expect(await obo.getToken(ctx, { audience: 'g', scopes: ['a', 'b'] })).toBe('t2');
  });
});
