// SPDX-License-Identifier: MIT
/**
 * A stateless, remote MCP endpoint that answers two protocol eras on one URL.
 *
 * - **2025-11-25 and older** (session era): `initialize`, then requests that repeat the revision in the
 *   `MCP-Protocol-Version` header. Served statelessly (no session id), JSON responses only.
 * - **2026-07-28** (stateless era): no handshake; `server/discover`; each request names its revision
 *   (header and/or `params._meta`) and carries `Mcp-Method` (and `Mcp-Name` for named calls); each result
 *   says its `resultType`; a call that needs the person answers `input_required`.
 *
 * On top of the wire protocol it holds three guards a remote server needs:
 *
 * 1. **Who is calling** comes only from the host: the required `contextFactory` sees what the host
 *    verified (`authInfo`), never the caller's params. A refusal is HTTP 401 with the RFC 9728
 *    `resource_metadata` challenge, so a client can find the authorization server.
 * 2. **Scope-to-tool**: every tool names the scopes it needs. A tool is listed only under them; a call
 *    without them is HTTP 403 `insufficient_scope` naming the scope to ask for (step-up).
 * 3. **Manifest hashing**: `tools/list` publishes a hash of the list this caller saw; a call that carries
 *    a hash the list no longer matches is refused, so a changed tool cannot ride on an old agreement.
 *
 * And one hook: **confirm**, run before every call. It can let the call proceed, refuse it, or ask for a
 * URL elicitation (the person confirms in their own browser, the client retries). The hook is handed the
 * call's parameter hash, so a confirmation can be bound to exactly these arguments.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ExecutionContext } from '@weaveintel/core';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServerInfo, McpTool, McpToolResult } from './jsonrpc.js';
import { MCPServerConfigError, type MCPContextFactory, type MCPRequestInfo } from './server.js';
import {
  negotiateMcpProtocolVersion,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  type McpProtocolEra,
} from './protocol-versions.js';
import { MCP_MANIFEST_META_KEY, manifestHash, parameterHash } from './manifest.js';
import {
  assertScopeToken,
  bearerChallenge,
  insufficientScopeChallenge,
  missingScopes,
} from './scopes.js';
import {
  assertUrlElicitation,
  isUrlElicitationOutcome,
  readElicitationAnswers,
  urlElicitationError,
  urlElicitationInputRequired,
  type ElicitationAnswer,
  type UrlElicitationOutcome,
} from './elicitation.js';

export { urlElicitationRequired } from './elicitation.js';

/** JSON-RPC error: the tool list changed since the client listed it (ours, not the spec's). */
export const MCP_ERROR_MANIFEST_CHANGED = -32050;
/** JSON-RPC error carried in the body of an HTTP 403 `insufficient_scope` (ours; the spec sets only the HTTP status and header). */
export const MCP_ERROR_INSUFFICIENT_SCOPE = -32051;
/** JSON-RPC error carried in the body of an HTTP 401 (ours). */
export const MCP_ERROR_UNAUTHENTICATED = -32052;

/** The spec's tool-name character set (2025-11-25 guidance): 1–128 of A–Z a–z 0–9 _ - . */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** One HTTP request, framework-neutral. Header names may be any case. */
export interface McpHttpRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The parsed JSON body (undefined when there was none). */
  readonly body: unknown;
  /** What the host verified about the caller's credential. Absent: unauthenticated. */
  readonly authInfo?: AuthInfo;
  readonly signal?: AbortSignal;
}

/** One HTTP response, framework-neutral. Header names are lower case. */
export interface McpHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  /** JSON body; undefined means no body (202, 405). */
  readonly body?: unknown;
}

/** Everything a confirm hook or tool handler knows about one call. */
export interface McpToolCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** The context the host's factory built for this request. */
  readonly ctx: ExecutionContext;
  readonly protocolVersion: string;
  readonly era: McpProtocolEra;
  /** `parameterHash(name, args)`: bind a confirmation to exactly these arguments. */
  readonly argsHash: string;
  /** The manifest hash of the tool list this caller is shown. */
  readonly manifestHash: string;
  /**
   * The client's answers to earlier elicitations, keyed by elicitation id (2026-07-28 retries only;
   * always empty in the session era). Hints, never proof: an "accept" must be matched to a grant the
   * server holds.
   */
  readonly answers: Readonly<Record<string, ElicitationAnswer>>;
  readonly signal: AbortSignal;
}

/** A tool handler returns a result, or asks for a URL elicitation. */
export type McpToolHandlerOutcome = McpToolResult | UrlElicitationOutcome;

/** A tool on the endpoint: what clients see, the scopes it needs, and what runs. */
export interface McpEndpointTool {
  readonly tool: McpTool;
  /** OAuth scopes the caller's token must carry, all of them. `[]` means any authenticated caller. Required. */
  readonly scopes: readonly string[];
  readonly handler: (call: McpToolCall) => Promise<McpToolHandlerOutcome>;
}

/** What the confirm hook decides for one call. */
export type McpConfirmDecision =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'refuse'; readonly message: string }
  | UrlElicitationOutcome;

export interface McpEndpointOptions {
  readonly serverInfo: McpServerInfo;
  /** Required. Builds the context from what the host verified; throw to refuse (HTTP 401). */
  readonly contextFactory: MCPContextFactory;
  /** The tools, or a function giving the tools this caller may be shown (e.g. per tenant). */
  readonly tools:
    | readonly McpEndpointTool[]
    | ((ctx: ExecutionContext) => readonly McpEndpointTool[] | Promise<readonly McpEndpointTool[]>);
  /** The scopes the caller's token carries. Default: `authInfo.scopes`. */
  readonly scopesOf?: (request: MCPRequestInfo, ctx: ExecutionContext) => readonly string[];
  /** RFC 9728 protected-resource metadata URL, named in the 401 and 403 challenges. */
  readonly resourceMetadataUrl?: string;
  /** Revisions to answer (default: all supported). */
  readonly protocolVersions?: readonly string[];
  /** Runs before every tool call; see `McpConfirmDecision`. A throw refuses the call. */
  readonly confirm?: (call: McpToolCall) => McpConfirmDecision | Promise<McpConfirmDecision>;
  /** What to do when a call carries a manifest hash the list no longer matches. Default `refuse`. */
  readonly manifestMismatch?: 'refuse' | 'ignore';
}

export interface McpServeOptions {
  /** What the host verified; falls back to `req.auth` (the SDK's convention). */
  readonly authInfo?: AuthInfo;
  /** Largest body accepted, in bytes (default 1 MiB); larger is HTTP 413. */
  readonly maxBodyBytes?: number;
}

export interface McpEndpoint {
  /** Answer one request (framework-neutral). Never throws. */
  handle(request: McpHttpRequest): Promise<McpHttpResponse>;
  /** Read, answer and write one Node HTTP request. */
  serve(req: IncomingMessage, res: ServerResponse, options?: McpServeOptions): Promise<void>;
}

type Rec = Record<string, unknown>;
type RpcId = string | number | null;

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function rpcOk(id: RpcId, result: unknown): Rec {
  return { jsonrpc: '2.0', id, result };
}
function rpcErr(id: RpcId, code: number, message: string, data?: unknown): Rec {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}
function json(status: number, body: Rec, extra: Record<string, string> = {}): McpHttpResponse {
  return { status, headers: { ...JSON_HEADERS, ...extra }, body };
}

function validateTools(tools: readonly McpEndpointTool[]): void {
  if (!Array.isArray(tools)) throw new MCPServerConfigError('MCP endpoint tools must be an array');
  const names = new Set<string>();
  for (const t of tools) {
    const name = t?.tool?.name;
    if (typeof name !== 'string' || !TOOL_NAME.test(name))
      throw new MCPServerConfigError(
        `MCP tool name ${JSON.stringify(name)} is outside the spec character set`,
      );
    if (names.has(name)) throw new MCPServerConfigError(`MCP tool "${name}" is defined twice`);
    names.add(name);
    if (!Array.isArray(t.scopes))
      throw new MCPServerConfigError(
        `MCP tool "${name}" names no scopes; pass [] to open it to any authenticated caller`,
      );
    for (const s of t.scopes) {
      try {
        assertScopeToken(s);
      } catch {
        throw new MCPServerConfigError(
          `MCP tool "${name}" has an invalid scope ${JSON.stringify(s)}`,
        );
      }
    }
    if (typeof t.handler !== 'function')
      throw new MCPServerConfigError(`MCP tool "${name}" has no handler`);
  }
}

function lowerHeaders(headers: McpHttpRequest['headers']): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers ?? {}))
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

/** Build the endpoint. Throws `MCPServerConfigError` for a configuration that would fail open. */
export function weaveMcpEndpoint(options: McpEndpointOptions): McpEndpoint {
  if (!options || typeof options.contextFactory !== 'function') {
    throw new MCPServerConfigError(
      `MCP endpoint '${options?.serverInfo?.name ?? ''}' needs a contextFactory: an MCP caller has no identity by default`,
    );
  }
  if (typeof options.tools !== 'function') validateTools(options.tools);
  const enabled = (options.protocolVersions ?? MCP_SUPPORTED_PROTOCOL_VERSIONS).filter((v) =>
    MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(v),
  );
  if (enabled.length === 0)
    throw new MCPServerConfigError('MCP endpoint has no supported protocol version switched on');
  const mismatch = options.manifestMismatch ?? 'refuse';
  const resourceMetadataUrl = options.resourceMetadataUrl;

  async function toolsFor(ctx: ExecutionContext): Promise<readonly McpEndpointTool[]> {
    if (typeof options.tools !== 'function') return options.tools;
    const list = await options.tools(ctx);
    validateTools(list);
    return list;
  }

  async function answer(request: McpHttpRequest): Promise<McpHttpResponse> {
    if (request.method !== 'POST') return { status: 405, headers: { allow: 'POST' } };
    const msg = request.body as Rec | undefined;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return json(
        400,
        rpcErr(
          null,
          -32600,
          'Invalid Request: one JSON-RPC message per POST (batches are not supported)',
        ),
      );
    }
    const id: RpcId =
      typeof msg['id'] === 'string' || typeof msg['id'] === 'number' ? msg['id'] : null;
    const isResponse = msg['method'] === undefined && ('result' in msg || 'error' in msg);
    if (msg['jsonrpc'] !== '2.0' || (!isResponse && typeof msg['method'] !== 'string'))
      return json(400, rpcErr(id, -32600, 'Invalid Request'));
    if (isResponse) return { status: 202, headers: {} }; // this server never sends requests, so a reply is dropped

    const method = msg['method'] as string;
    const params =
      msg['params'] && typeof msg['params'] === 'object' && !Array.isArray(msg['params'])
        ? (msg['params'] as Rec)
        : undefined;
    const headers = lowerHeaders(request.headers);

    const v = negotiateMcpProtocolVersion({
      rpcMethod: method,
      header: headers['mcp-protocol-version'],
      meta: params?.['_meta'],
      initializeAsk: params?.['protocolVersion'],
      enabled,
    });
    if (!v.ok) return json(400, rpcErr(id, -32600, v.reason, { supportedVersions: enabled }));

    // 2026-07-28 routes on headers; a header that disagrees with the body could steer a proxy one way and us another.
    if (v.era === 'stateless') {
      if (headers['mcp-method'] !== method)
        return json(
          400,
          rpcErr(id, -32600, 'Mcp-Method header missing or does not match the request method'),
        );
      const named =
        method === 'tools/call' || method === 'prompts/get'
          ? params?.['name']
          : method === 'resources/read'
            ? params?.['uri']
            : undefined;
      if (named !== undefined && headers['mcp-name'] !== named)
        return json(
          400,
          rpcErr(id, -32600, 'Mcp-Name header missing or does not match the request'),
        );
    }

    const signal = request.signal ?? new AbortController().signal;
    const info: MCPRequestInfo = {
      method,
      requestId: id ?? '',
      signal,
      ...(request.authInfo ? { authInfo: request.authInfo } : {}),
      headers: request.headers,
    };
    let ctx: ExecutionContext;
    try {
      ctx = await options.contextFactory(info);
      if (!ctx) throw new Error('no context');
    } catch {
      return json(
        401,
        rpcErr(
          id,
          MCP_ERROR_UNAUTHENTICATED,
          'Unauthenticated: the MCP caller could not be identified',
        ),
        {
          'www-authenticate': bearerChallenge(
            resourceMetadataUrl ? { resourceMetadata: resourceMetadataUrl } : {},
          ),
        },
      );
    }

    if (method.startsWith('notifications/') || msg['id'] === undefined)
      return { status: 202, headers: {} };

    const complete = (result: Rec): Rec =>
      v.era === 'stateless' ? { resultType: 'complete', ...result } : result;
    const ok = (result: Rec): McpHttpResponse => json(200, rpcOk(id, complete(result)));

    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: v.version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.serverInfo.name, version: options.serverInfo.version },
          ...(options.serverInfo.instructions
            ? { instructions: options.serverInfo.instructions }
            : {}),
        });
      case 'server/discover':
        return ok({
          supportedVersions: [...enabled],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.serverInfo.name, version: options.serverInfo.version },
          ...(options.serverInfo.instructions
            ? { instructions: options.serverInfo.instructions }
            : {}),
        });
      case 'ping':
        return ok({});
      case 'resources/list':
        return ok({ resources: [] });
      case 'prompts/list':
        return ok({ prompts: [] });
      case 'tools/list':
      case 'tools/call':
        break;
      default:
        return json(200, rpcErr(id, -32601, `Method not found: ${method}`));
    }

    let all: readonly McpEndpointTool[];
    try {
      all = await toolsFor(ctx);
    } catch {
      return json(500, rpcErr(id, -32603, 'Internal error'));
    }
    const granted = [
      ...(options.scopesOf ? options.scopesOf(info, ctx) : (request.authInfo?.scopes ?? [])),
    ];
    const visible = all.filter((t) => missingScopes(t.scopes, granted).length === 0);
    const listed = visible.map((t) => ({ ...t.tool }));
    const hash = manifestHash(listed);
    const manifestMeta = { [MCP_MANIFEST_META_KEY]: { hash } };

    if (method === 'tools/list') return ok({ tools: listed, _meta: manifestMeta });

    // tools/call
    const name = params?.['name'];
    if (typeof name !== 'string' || name === '')
      return json(200, rpcErr(id, -32602, 'Invalid params: tool name required'));
    const entry = all.find((t) => t.tool.name === name);
    if (!entry) return json(200, rpcErr(id, -32602, `Unknown tool: ${name}`));

    const challenge = insufficientScopeChallenge({
      required: entry.scopes,
      granted,
      resourceMetadataUrl,
    });
    if (challenge.missing.length > 0) {
      return json(
        403,
        rpcErr(id, MCP_ERROR_INSUFFICIENT_SCOPE, 'insufficient_scope', {
          missingScopes: challenge.missing,
        }),
        { 'www-authenticate': challenge.wwwAuthenticate },
      );
    }

    const rawArgs = params?.['arguments'];
    if (
      rawArgs !== undefined &&
      (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs))
    ) {
      return json(200, rpcErr(id, -32602, 'Invalid params: arguments must be an object'));
    }
    const args = (rawArgs ?? {}) as Rec;

    const seenRaw = (params?.['_meta'] as Rec | undefined)?.[MCP_MANIFEST_META_KEY];
    const seen =
      typeof seenRaw === 'string'
        ? seenRaw
        : seenRaw && typeof seenRaw === 'object'
          ? (seenRaw as Rec)['hash']
          : undefined;
    if (mismatch === 'refuse' && seen !== undefined && seen !== hash) {
      return json(
        200,
        rpcErr(
          id,
          MCP_ERROR_MANIFEST_CHANGED,
          'The tool list has changed since you listed it; list the tools again before calling',
          { manifestHash: hash },
        ),
      );
    }

    let argsHash: string;
    try {
      argsHash = parameterHash(name, args);
    } catch {
      return json(200, rpcErr(id, -32602, 'Invalid params: arguments are not plain JSON'));
    }
    const answers = v.era === 'stateless' ? readElicitationAnswers(params, argsHash) : {};
    const call: McpToolCall = {
      name,
      args,
      ctx,
      protocolVersion: v.version,
      era: v.era,
      argsHash,
      manifestHash: hash,
      answers,
      signal,
    };
    const withMeta = (r: McpToolResult): Rec => ({
      ...r,
      _meta: { ...(r._meta ?? {}), ...manifestMeta },
    });

    const elicit = (o: UrlElicitationOutcome): McpHttpResponse => {
      try {
        assertUrlElicitation(o.elicitation);
      } catch {
        return json(500, rpcErr(id, -32603, 'Internal error'));
      }
      return v.era === 'stateless'
        ? json(200, rpcOk(id, urlElicitationInputRequired(o.elicitation, argsHash)))
        : json(200, { jsonrpc: '2.0', id, error: urlElicitationError(o.elicitation) });
    };

    // A person who declined or dismissed the confirmation is final for this call.
    if (Object.values(answers).some((a) => a.action !== 'accept')) {
      return ok(
        withMeta({
          content: [
            { type: 'text', text: 'The person did not confirm this action, so nothing was done.' },
          ],
          isError: true,
        }),
      );
    }

    if (options.confirm) {
      let decision: McpConfirmDecision;
      try {
        decision = await options.confirm(call);
      } catch {
        return ok(
          withMeta({
            content: [
              { type: 'text', text: `Tool "${name}" could not be confirmed, so nothing was done.` },
            ],
            isError: true,
          }),
        );
      }
      if (isUrlElicitationOutcome(decision)) return elicit(decision);
      if (!decision || decision.kind !== 'proceed') {
        const message =
          decision && decision.kind === 'refuse' && typeof decision.message === 'string'
            ? decision.message
            : 'This action was refused.';
        return ok(withMeta({ content: [{ type: 'text', text: message }], isError: true }));
      }
    }

    let outcome: McpToolHandlerOutcome;
    try {
      outcome = await entry.handler(call);
    } catch {
      return ok(
        withMeta({ content: [{ type: 'text', text: `Tool "${name}" failed.` }], isError: true }),
      );
    }
    if (isUrlElicitationOutcome(outcome)) return elicit(outcome);
    return ok(withMeta(outcome));
  }

  /** `answer`, made total: anything unexpected is a generic 500, never a stack or a partial answer. */
  async function handle(request: McpHttpRequest): Promise<McpHttpResponse> {
    try {
      return await answer(request);
    } catch {
      return json(500, rpcErr(null, -32603, 'Internal error'));
    }
  }

  async function serve(
    req: IncomingMessage,
    res: ServerResponse,
    serveOptions: McpServeOptions = {},
  ): Promise<void> {
    const write = (r: McpHttpResponse): void => {
      if (res.headersSent) return;
      res.writeHead(r.status, r.headers);
      res.end(r.body === undefined ? undefined : JSON.stringify(r.body));
    };
    const limit = serveOptions.maxBodyBytes ?? 1024 * 1024;
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });

    let body: unknown;
    if (req.method === 'POST') {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) {
        req.resume();
        write(json(413, rpcErr(null, -32600, 'Request body too large'), { connection: 'close' }));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      try {
        for await (const chunk of req) {
          const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          size += b.length;
          if (size > limit) tooLarge = true;
          if (!tooLarge) chunks.push(b);
        }
      } catch {
        write(json(400, rpcErr(null, -32600, 'Could not read the request body')));
        return;
      }
      if (tooLarge) {
        write(json(413, rpcErr(null, -32600, 'Request body too large'), { connection: 'close' }));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() !== '') {
        try {
          body = JSON.parse(raw);
        } catch {
          write(json(400, rpcErr(null, -32700, 'Parse error')));
          return;
        }
      }
    }
    const authInfo = serveOptions.authInfo ?? (req as IncomingMessage & { auth?: AuthInfo }).auth;
    write(
      await handle({
        method: req.method ?? 'GET',
        headers: req.headers,
        body,
        signal: abort.signal,
        ...(authInfo ? { authInfo } : {}),
      }),
    );
  }

  return { handle, serve };
}
