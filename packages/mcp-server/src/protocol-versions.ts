// SPDX-License-Identifier: MIT
/**
 * MCP protocol revisions this package answers, and how one request picks its revision.
 *
 * Two eras:
 * - **session** (2024-11-05 … 2025-11-25): the client opens with `initialize`, the server answers the
 *   revision both speak, and later HTTP requests repeat it in the `MCP-Protocol-Version` header.
 * - **stateless** (2026-07-28): there is no `initialize`; every request carries its revision (in the
 *   header and/or in `params._meta`), discovery is `server/discover`, and every result says its
 *   `resultType`.
 *
 * A server can serve both at once: the revision is settled per request, so a 2025-11-25 client and a
 * 2026-07-28 client can share one endpoint.
 */

/** The last session-era revision (the one the official SDKs and most clients speak today). */
export const MCP_PROTOCOL_VERSION_2025_11_25 = '2025-11-25';
/** The stateless revision. */
export const MCP_PROTOCOL_VERSION_2026_07_28 = '2026-07-28';

/** Session-era revisions answered, newest first. */
export const MCP_SESSION_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);
/** Stateless-era revisions answered, newest first. */
export const MCP_STATELESS_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([
  MCP_PROTOCOL_VERSION_2026_07_28,
]);
/** Every revision answered, newest first. */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([
  ...MCP_STATELESS_PROTOCOL_VERSIONS,
  ...MCP_SESSION_PROTOCOL_VERSIONS,
]);

/**
 * The `params._meta` key a stateless request names its revision under.
 * ASSUMPTION (spec text not on disk): the 2026-07-28 changelog says requests carry "version and
 * capabilities in `_meta`" under the reserved `io.modelcontextprotocol/` prefix; this exact key is ours to
 * confirm against the published schema.
 */
export const MCP_META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';

/** The revision the 2025 transport says to assume when a request names none. */
const DEFAULT_UNNAMED_VERSION = '2025-03-26';

export type McpProtocolEra = 'session' | 'stateless';

export type McpVersionNegotiation =
  | { readonly ok: true; readonly version: string; readonly era: McpProtocolEra }
  | { readonly ok: false; readonly reason: string };

export interface McpVersionInput {
  /** The JSON-RPC method of the request. */
  readonly rpcMethod: string;
  /** The `MCP-Protocol-Version` header, if any. */
  readonly header?: string | undefined;
  /** The request's `params._meta`, if any. */
  readonly meta?: unknown;
  /** For `initialize`: the `params.protocolVersion` the client asked for. */
  readonly initializeAsk?: unknown;
  /** The revisions this server has switched on (default: all supported). */
  readonly enabled?: readonly string[] | undefined;
}

/** Which era a supported revision belongs to. */
export function mcpProtocolEra(version: string): McpProtocolEra {
  return MCP_STATELESS_PROTOCOL_VERSIONS.includes(version) ? 'stateless' : 'session';
}

/**
 * Settle the revision for one request. Never throws; a refusal carries the reason the caller is told
 * (with HTTP 400, as the 2025 transport requires for a revision the server does not support).
 */
export function negotiateMcpProtocolVersion(input: McpVersionInput): McpVersionNegotiation {
  const enabled = (input.enabled ?? MCP_SUPPORTED_PROTOCOL_VERSIONS).filter((v) =>
    MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(v),
  );
  const supportedList = enabled.join(', ');

  // server/discover is how a stateless client learns what we speak, so it is answered whatever it names.
  if (input.rpcMethod === 'server/discover') {
    const stateless = enabled.find((v) => mcpProtocolEra(v) === 'stateless');
    return stateless
      ? { ok: true, version: stateless, era: 'stateless' }
      : {
          ok: false,
          reason: `server/discover is not offered; supported versions: ${supportedList}`,
        };
  }

  // initialize exists only in the session era: answer the client's revision if we speak it, else our newest.
  if (input.rpcMethod === 'initialize') {
    const session = enabled.filter((v) => mcpProtocolEra(v) === 'session');
    if (session.length === 0)
      return {
        ok: false,
        reason: `initialize is not offered; supported versions: ${supportedList}`,
      };
    const asked = typeof input.initializeAsk === 'string' ? input.initializeAsk : '';
    return { ok: true, version: session.includes(asked) ? asked : session[0]!, era: 'session' };
  }

  const header =
    typeof input.header === 'string' && input.header.trim() !== ''
      ? input.header.trim()
      : undefined;
  const metaRaw =
    input.meta && typeof input.meta === 'object'
      ? (input.meta as Record<string, unknown>)[MCP_META_PROTOCOL_VERSION]
      : undefined;
  const meta = typeof metaRaw === 'string' && metaRaw !== '' ? metaRaw : undefined;
  if (header !== undefined && meta !== undefined && header !== meta) {
    return {
      ok: false,
      reason: `MCP-Protocol-Version header (${header}) and _meta version (${meta}) disagree`,
    };
  }
  const named = meta ?? header;
  if (named === undefined) {
    return enabled.includes(DEFAULT_UNNAMED_VERSION)
      ? { ok: true, version: DEFAULT_UNNAMED_VERSION, era: 'session' }
      : { ok: false, reason: `No protocol version given; supported versions: ${supportedList}` };
  }
  if (!enabled.includes(named))
    return {
      ok: false,
      reason: `Unsupported protocol version ${named}; supported versions: ${supportedList}`,
    };
  return { ok: true, version: named, era: mcpProtocolEra(named) };
}
