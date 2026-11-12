// SPDX-License-Identifier: MIT
/**
 * The MCP source (the "default tool access" route for drives with no adapter
 * here) and the resolver that picks a source for a ref.
 */

import type { ExecutionContext } from '@weaveintel/core';
import { sniffMimeType } from '../files/sniff.js';
import { SourceError, fetchedAs, type FetchedFile, type FileSource, type RefOrigin, type SourceIdentity } from './types.js';

// ─── MCP ─────────────────────────────────────────────────────

/** The one call this source needs from an MCP client. */
export interface McpToolCaller {
  callTool(name: string, args: Record<string, unknown>, ctx: ExecutionContext, identity: SourceIdentity): Promise<{
    content?: Array<
      | { type: 'text'; text: string }
      | { type: 'image' | 'audio'; data: string; mimeType?: string }
      | { type: 'resource'; resource: { uri?: string; mimeType?: string; blob?: string; text?: string } }
    >;
    isError?: boolean;
  }>;
}

export interface McpFileSourceConfig {
  /** A name for this source, e.g. "mcp:sharefile". */
  readonly id: string;
  /** Refs it handles: a prefix such as "sharefile:" or a URL host suffix. */
  readonly refPrefix?: string;
  readonly urlHost?: string;
  /** The read-file tool's name. */
  readonly tool: string;
  /**
   * The tool's arguments as data. `{ref}` in a string value is replaced by the
   * ref (with the prefix removed), e.g. `{ "path": "{ref}", "as": "base64" }`.
   */
  readonly args: Readonly<Record<string, unknown>>;
  /** Accept a text-only answer as UTF-8 bytes (binary files would be damaged). Default false. */
  readonly acceptText?: boolean;
}

export function createMcpFileSource(client: McpToolCaller, config: McpFileSourceConfig): FileSource {
  const strip = (ref: string): string => (config.refPrefix && ref.startsWith(config.refPrefix) ? ref.slice(config.refPrefix.length) : ref);
  const fill = (v: unknown, ref: string): unknown =>
    typeof v === 'string' ? v.split('{ref}').join(ref) : Array.isArray(v) ? v.map((x) => fill(x, ref)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, ref)])) : v;
  return {
    id: config.id,
    capabilities: { list: false, changes: false, acl: false, checkAccess: false, notes: `Reads files through the MCP tool "${config.tool}".` },
    canResolve(ref) {
      if (config.refPrefix && ref.startsWith(config.refPrefix)) return true;
      if (config.urlHost) {
        try { const h = new URL(ref).hostname; return h === config.urlHost || h.endsWith(`.${config.urlHost}`); } catch { return false; }
      }
      return false;
    },
    async resolve(ctx, ref, identity): Promise<FetchedFile> {
      const args = fill(config.args, strip(ref)) as Record<string, unknown>;
      const res = await client.callTool(config.tool, args, ctx, identity);
      if (res.isError) {
        const msg = res.content?.find((c) => c.type === 'text') as { text?: string } | undefined;
        throw new SourceError('mcp_tool_error', `The MCP tool ${config.tool} failed${msg?.text ? `: ${msg.text.slice(0, 200)}` : ''}.`, 'TOOL_ERROR');
      }
      let bytes: Uint8Array | undefined;
      let mime: string | undefined;
      let uri: string | undefined;
      const notes: string[] = [];
      for (const c of res.content ?? []) {
        if (c.type === 'resource' && c.resource.blob) {
          bytes = Uint8Array.from(Buffer.from(c.resource.blob, 'base64'));
          mime = c.resource.mimeType;
          uri = c.resource.uri;
          break;
        }
        if ((c.type === 'image' || c.type === 'audio') && c.data) {
          bytes = Uint8Array.from(Buffer.from(c.data, 'base64'));
          mime = c.mimeType;
          break;
        }
      }
      if (!bytes) {
        const text = (res.content ?? []).map((c) => (c.type === 'text' ? c.text : c.type === 'resource' ? c.resource.text ?? '' : '')).join('');
        if (!config.acceptText || !text) {
          throw new SourceError('mcp_no_bytes', `The MCP tool ${config.tool} returned no file bytes (only text), so a binary file would be damaged.`, 'TOOL_ERROR');
        }
        bytes = new TextEncoder().encode(text);
        mime = 'text/plain';
        notes.push('The MCP tool returned text, kept as UTF-8.');
      }
      return {
        source: config.id,
        bytes,
        ...(mime ? { declaredMimeType: mime } : {}),
        size: bytes.length,
        sourceUrl: uri ?? ref,
        fetchedAs: fetchedAs(identity),
        fetchedAt: new Date().toISOString(),
        ...(notes.length ? { notes } : {}),
      };
    },
  };
}

// ─── Resolver ────────────────────────────────────────────────

export interface ResolvedFile extends FetchedFile {
  /** The type the BYTES are (sniffed), which is what the reader should use. */
  readonly sniffedMimeType: string;
  readonly origin: RefOrigin;
}

export interface SourceResolver {
  /** Which source would take a ref (none: undefined). */
  sourceFor(ref: string): FileSource | undefined;
  /**
   * Fetch a ref. `origin` must say where the ref came from: only refs a PERSON
   * gave (`user`) or a configuration names (`configured`) are fetched. A URL
   * found inside a document (`document`) is data and is never fetched.
   */
  resolve(ctx: ExecutionContext, ref: string, identity: SourceIdentity, origin: RefOrigin): Promise<ResolvedFile>;
  /** For a host's capability page. */
  capabilities(): Array<{ id: string } & FileSource['capabilities']>;
}

/** Sources are tried in order; put the specific ones (Graph, Drive ...) before the plain URL source. */
export function createSourceResolver(sources: readonly FileSource[]): SourceResolver {
  const sourceFor = (ref: string): FileSource | undefined => sources.find((s) => s.canResolve(ref));
  return {
    sourceFor,
    async resolve(ctx, ref, identity, origin) {
      if (origin !== 'user' && origin !== 'configured') {
        throw new SourceError('origin_not_allowed', 'Links found inside a file are never fetched automatically; a person has to open them.', 'POLICY_DENIED');
      }
      const s = sourceFor(ref);
      if (!s) throw new SourceError('no_source', 'No configured source can fetch that link.', 'NOT_FOUND');
      const f = await s.resolve(ctx, ref, identity);
      return { ...f, sniffedMimeType: sniffMimeType(f.bytes, f.declaredMimeType).mimeType, origin };
    },
    capabilities: () => sources.map((s) => ({ id: s.id, ...s.capabilities })),
  };
}

/**
 * A token provider for on-behalf-of exchange: the host supplies the person's
 * own sign-in assertion and the exchange (Entra OBO, Google token exchange).
 * Tokens are cached per audience+scopes until shortly before they expire.
 */
export function createOnBehalfOfTokenProvider(opts: {
  readonly assertion: (ctx: ExecutionContext) => Promise<string>;
  readonly exchange: (assertion: string, request: { audience: string; scopes: readonly string[] }) => Promise<{ accessToken: string; expiresInSeconds: number }>;
  readonly now?: () => number;
}): { getToken(ctx: ExecutionContext, request: { audience: string; scopes: readonly string[] }): Promise<string> } {
  const cache = new Map<string, { token: string; until: number }>();
  const now = opts.now ?? Date.now;
  return {
    async getToken(ctx, request) {
      const key = `${request.audience} ${[...request.scopes].sort().join(' ')}`;
      const hit = cache.get(key);
      if (hit && hit.until > now()) return hit.token;
      const r = await opts.exchange(await opts.assertion(ctx), request);
      cache.set(key, { token: r.accessToken, until: now() + Math.max(0, r.expiresInSeconds - 60) * 1000 });
      return r.accessToken;
    },
  };
}
