/**
 * Internal MCP Gateway — Phase 1D
 *
 * Exposes a curated subset of GeneWeave builtin tools (web, social, search,
 * cse, http, enterprise, communication classes by default) over the MCP
 * Streamable HTTP transport so external clients (Claude Desktop, other
 * GeneWeave instances, or arbitrary MCP-aware agents) can use them through
 * a single bearer-token authenticated endpoint.
 *
 * Transport mode: stateless. Per the @modelcontextprotocol/sdk contract,
 * stateless transports must NOT be reused across requests (otherwise
 * message-ID collisions occur — see SDK source comment in
 * webStandardStreamableHttp.js around line 137). We therefore build a fresh
 * MCP server + transport pair per request from a cached set of tool
 * registrations.
 *
 * Why an internal gateway: The platform-level direction is to wrap every
 * external tool as MCP so tools become swappable, credential-managed, and
 * observability-uniform. Surfacing the existing in-process Tool registry as
 * one MCP server avoids a separate process per tool family. Tool selection
 * is driven by the same `inferAllocationClass()` taxonomy that powers
 * `tool_catalog.allocation_class`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  weaveMCPServer,
  createMCPStreamableHttpServerTransport,
  type MCPStreamableHttpServerTransport,
} from '@weaveintel/mcp-server';
import { weaveContext } from '@weaveintel/core';
import type { ExecutionContext, Tool, MCPToolCallResponse, JsonSchema } from '@weaveintel/core';
import {
  createPolicyEnforcedTool,
  type ToolPolicyResolver,
  type ToolAuditEmitter,
  type ToolRateLimiter,
  type PolicyResolutionContext,
} from '@weaveintel/tools';
import { BUILTIN_TOOLS, inferAllocationClass } from './tools.js';
import type { DatabaseAdapter, MCPGatewayClientRow } from './db-types.js';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

/** Allocation classes considered "external" — these are exposed by default. */
export const DEFAULT_EXPOSED_ALLOCATION_CLASSES: ReadonlySet<string> = new Set([
  'web',
  'social',
  'search',
  'cse',
  'http',
  'enterprise',
  'communication',
]);

/** Stable tool_key used to self-register the gateway in tool_catalog. */
export const MCP_GATEWAY_TOOL_KEY = 'geneweave_mcp_gateway';
/** Stable credential name used to self-register the gateway's bearer-token credential. */
export const MCP_GATEWAY_CREDENTIAL_NAME = 'GeneWeave MCP Gateway Token';
/** Default env var the gateway reads its bearer token from. */
export const MCP_GATEWAY_DEFAULT_ENV_VAR = 'GENEWEAVE_MCP_GATEWAY_TOKEN';

export interface MCPGatewayOptions {
  /** Override which tools are exposed. When omitted, BUILTIN_TOOLS is used. */
  tools?: Record<string, Tool>;
  /** Override which allocation classes are exposed. */
  exposedClasses?: ReadonlySet<string>;
  /** Bearer token required on every request. When undefined, the gateway is disabled. */
  token?: string;
  /** Server name reported in the MCP initialize handshake. Defaults to `geneweave-gateway`. */
  serverName?: string;
  /** Server version reported in the MCP initialize handshake. */
  serverVersion?: string;
  /**
   * Optional policy resolver. When provided, every tool exposed through the
   * gateway is wrapped with the standard policy enforcement chain (enabled
   * check → risk-level → approval → rate-limit → execute → audit) so the
   * gateway honours the same operator policies as in-process chat tools.
   */
  policyResolver?: ToolPolicyResolver;
  /** Optional audit emitter. Recommended whenever `policyResolver` is set. */
  auditEmitter?: ToolAuditEmitter;
  /** Optional rate limiter. Used by policy enforcement when a policy declares per-minute caps. */
  rateLimiter?: ToolRateLimiter;
  /**
   * Synthetic chat id stamped on every audit event emitted by the gateway.
   * Defaults to `'mcp-gateway'`. Use to distinguish external MCP traffic
   * from in-process chat sessions in the audit log.
   */
  auditChatId?: string;
  /** Synthetic agent persona stamped on every audit event. Defaults to `'mcp-gateway'`. */
  auditAgentPersona?: string;
  /**
   * Phase 5 — multi-tenant client resolver. When provided, every request
   * must present a bearer token whose SHA-256 digest matches a row in
   * `mcp_gateway_clients`. The matched client supplies its own audit chatId
   * and may narrow the exposed allocation classes via `allowed_classes`.
   *
   * When both `token` and `clientResolver` are configured, the resolver
   * takes precedence — the legacy single-token check is skipped. A request
   * that fails the resolver lookup returns 401.
   */
  clientResolver?: (tokenHash: string) => Promise<MCPGatewayClientRow | null>;
  /**
   * Best-effort hook invoked after a successful client match so the DB
   * adapter can stamp `last_used_at`. Failures must not block the request.
   */
  touchClient?: (clientId: string) => Promise<void>;
}

export interface MCPGatewayHandle {
  /** Inspect which tool keys are currently exposed. */
  readonly exposedToolNames: string[];
  /** True iff a token was supplied and the gateway accepts requests. */
  readonly enabled: boolean;
  /** Handle a single HTTP request. */
  handle(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void>;
  /** Tear down (no-op for stateless gateways but keeps the handle symmetric). */
  close(): Promise<void>;
}

interface ExposedToolEntry {
  key: string;
  tool: Tool;
  allocationClass: string;
}

function selectExposedTools(
  tools: Record<string, Tool>,
  classes: ReadonlySet<string>,
): ExposedToolEntry[] {
  const out: ExposedToolEntry[] = [];
  for (const [key, tool] of Object.entries(tools)) {
    const cls = inferAllocationClass(key, tool.schema.tags);
    if (cls && classes.has(cls)) out.push({ key, tool, allocationClass: cls });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function toMCPResponse(content: string, isError: boolean | undefined): MCPToolCallResponse {
  return { content: [{ type: 'text', text: content }], isError: isError === true };
}

/**
 * Build a Streamable HTTP MCP gateway. Construction is synchronous so it can
 * be wired into the existing sync `createGeneWeaveServer` factory. The MCP
 * server + transport pair is created fresh on every request, as required by
 * the SDK in stateless mode.
 */
export function createMCPGateway(opts: MCPGatewayOptions): MCPGatewayHandle {
  const tools = opts.tools ?? BUILTIN_TOOLS;
  const classes = opts.exposedClasses ?? DEFAULT_EXPOSED_ALLOCATION_CLASSES;
  const exposed = selectExposedTools(tools, classes);
  const token = opts.token;
  const clientResolver = opts.clientResolver;
  const touchClient = opts.touchClient;
  const enabled = clientResolver != null || (typeof token === 'string' && token.length > 0);
  const serverName = opts.serverName ?? 'geneweave-gateway';
  const serverVersion = opts.serverVersion ?? '1.0.0';
  const exposedToolNames = exposed.map((e) => e.key);
  const policyResolver = opts.policyResolver;
  const auditEmitter = opts.auditEmitter;
  const rateLimiter = opts.rateLimiter;
  const defaultAuditChatId = opts.auditChatId ?? 'mcp-gateway';
  const auditAgentPersona = opts.auditAgentPersona ?? 'mcp-gateway';

  // Pre-wrap each exposed tool with policy enforcement (single-tenant path)
  // when a resolver is supplied AND no per-client resolver is configured.
  // For the multi-tenant path we wrap tools per-request because the audit
  // chatId is determined by the matched client.
  const enforcedSingleTenant: ExposedToolEntry[] = policyResolver && !clientResolver
    ? exposed.map((e) => {
        const resolutionContext: PolicyResolutionContext = {
          chatId: defaultAuditChatId,
          agentPersona: auditAgentPersona,
        };
        const wrapped = createPolicyEnforcedTool(e.tool, {
          resolver: policyResolver,
          ...(auditEmitter ? { auditEmitter } : {}),
          ...(rateLimiter ? { rateLimiter } : {}),
          resolutionContext,
        });
        return { key: e.key, tool: wrapped, allocationClass: e.allocationClass };
      })
    : exposed;

  /**
   * Wrap exposed tools per-request with a client-scoped policy resolution
   * context. The matched gateway client's row provides the audit chatId
   * (so external traffic is traceable per client) and may narrow the set
   * of allocation classes the client is allowed to invoke.
   */
  function wrapForClient(client: MCPGatewayClientRow): ExposedToolEntry[] {
    const allowed = parseAllowedClasses(client.allowed_classes);
    const filtered = allowed
      ? exposed.filter((e) => allowed.has(e.allocationClass))
      : exposed;
    if (!policyResolver) return filtered;
    const chatId = client.audit_chat_id ?? `mcp-gateway:${client.name}`;
    const resolutionContext: PolicyResolutionContext = {
      chatId,
      agentPersona: auditAgentPersona,
    };
    return filtered.map((e) => {
      const wrapped = createPolicyEnforcedTool(e.tool, {
        resolver: policyResolver,
        ...(auditEmitter ? { auditEmitter } : {}),
        ...(rateLimiter ? { rateLimiter } : {}),
        resolutionContext,
      });
      return { key: e.key, tool: wrapped, allocationClass: e.allocationClass };
    });
  }

  function unauthorized(res: ServerResponse): void {
    const body = JSON.stringify({ error: 'Unauthorized' });
    res.writeHead(401, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function disabledResponse(res: ServerResponse): void {
    const body = JSON.stringify({ error: 'MCP gateway is disabled (set GENEWEAVE_MCP_GATEWAY_TOKEN to enable)' });
    res.writeHead(503, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function extractBearer(req: IncomingMessage): string | null {
    const header = req.headers['authorization'] ?? req.headers['Authorization' as never];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || typeof value !== 'string') return null;
    const m = value.match(/^Bearer\s+(.+)$/i);
    return m && m[1] ? m[1] : null;
  }

  /**
   * Resolve the bearer token against either the multi-tenant client store
   * (preferred when configured) or the single-token legacy path.
   * Returns null when authentication fails for any reason.
   */
  async function authenticate(req: IncomingMessage): Promise<{ client: MCPGatewayClientRow | null } | null> {
    const presented = extractBearer(req);
    if (!presented) return null;
    if (clientResolver) {
      const hash = createHash('sha256').update(presented).digest('hex');
      let row: MCPGatewayClientRow | null = null;
      try {
        row = await clientResolver(hash);
      } catch {
        return null;
      }
      if (row) {
        if (row.enabled !== 1) return null;
        if (row.revoked_at) return null;
        return { client: row };
      }
      // Resolver miss — fall through to the legacy single-token path so
      // operators upgrading from Phase 4 keep working until at least one
      // client row is registered.
    }
    if (typeof token !== 'string' || token.length === 0) return null;
    // Constant-time string compare to deny token-length oracles.
    const a = Buffer.from(presented);
    const b = Buffer.from(token);
    if (a.length !== b.length) return null;
    return timingSafeEqual(a, b) ? { client: null } : null;
  }

  /**
   * Build a fresh MCP server + transport, register every exposed tool, and
   * connect the pair. Returns both so the caller can route the request and
   * tear them down afterwards.
   */
  async function buildPerRequestServer(entries: ExposedToolEntry[]): Promise<{ stop: () => Promise<void>; transport: MCPStreamableHttpServerTransport }> {
    const server = weaveMCPServer(
      {
        name: serverName,
        version: serverVersion,
        description:
          'GeneWeave internal MCP gateway exposing external builtin tools (web, social, search, cse, http, enterprise, communication).',
      },
      {
        contextFactory: (): ExecutionContext =>
          weaveContext({
            metadata: { source: 'mcp-gateway', persona: 'agent_supervisor' },
          }),
      },
    );

    for (const { key, tool, allocationClass } of entries) {
      server.addTool(
        {
          name: key,
          description: `[${allocationClass}] ${tool.schema.description}`,
          inputSchema: tool.schema.parameters as JsonSchema,
        },
        async (ctx, args) => {
          try {
            const result = await tool.invoke(ctx, { name: key, arguments: args });
            return toMCPResponse(result.content, result.isError);
          } catch (err) {
            // Policy violations and tool errors both surface here. The audit
            // event has already been emitted by the policy wrapper; we only
            // shape the MCP response back to the client.
            return toMCPResponse(`Error: ${(err as Error).message}`, true);
          }
        },
      );
    }

    const transport = createMCPStreamableHttpServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.start(transport);
    return {
      transport,
      stop: () => server.stop(),
    };
  }

  return {
    exposedToolNames,
    enabled,
    async handle(req, res, parsedBody) {
      if (!enabled) { disabledResponse(res); return; }
      const authResult = await authenticate(req);
      if (!authResult) { unauthorized(res); return; }
      const entries = authResult.client
        ? wrapForClient(authResult.client)
        : enforcedSingleTenant;
      // Stamp last_used_at for the matched client. Best-effort.
      if (authResult.client && touchClient) {
        void touchClient(authResult.client.id).catch(() => undefined);
      }
      const { transport, stop } = await buildPerRequestServer(entries);
      try {
        await transport.handleRequest(req, res, parsedBody);
      } finally {
        try { await stop(); } catch { /* best-effort */ }
      }
    },
    async close() {
      // No persistent resources held — nothing to clean up.
    },
  };
}

/** Parse the JSON-encoded `allowed_classes` column on a gateway client row.
 *  Returns null when the field is unset (client inherits gateway defaults)
 *  and an empty Set when the JSON is invalid (no classes allowed — fail closed). */
function parseAllowedClasses(raw: string | null): Set<string> | null {
  if (raw == null || raw === '') return null;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      return new Set(v as string[]);
    }
    return new Set();
  } catch {
    return new Set();
  }
}

/** SHA-256 hex digest of a plaintext bearer token. Exported so admin code
 *  can hash a freshly minted token before storing it. */
export function hashGatewayToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Options for {@link registerMCPGatewayInCatalog}.
 */
export interface RegisterMCPGatewayInCatalogOptions {
  /** Allocation classes the gateway exposes (defaults to {@link DEFAULT_EXPOSED_ALLOCATION_CLASSES}). */
  exposedClasses?: ReadonlySet<string>;
  /**
   * URL where this GeneWeave instance serves the gateway. Stored in the
   * catalog row's `config.endpoint`. When omitted, defaults to the
   * relative path `/api/mcp/gateway` so external readers can resolve it
   * against the host's public base URL.
   */
  endpoint?: string;
  /** Override the env var name recorded on the credential row. */
  envVarName?: string;
  /** Override the catalog tool_key (mainly for tests). */
  toolKey?: string;
  /** Override the credential record name (mainly for tests). */
  credentialName?: string;
  /** Override the BUILTIN_TOOLS map (mainly for tests). */
  tools?: Record<string, Tool>;
}

/**
 * Self-register the MCP gateway in the operator-managed `tool_catalog` table
 * and create a paired `tool_credentials` entry whose `env_var_name` points to
 * the bearer-token environment variable. Both rows are upserted, so this is
 * safe to call on every startup.
 *
 * Why both rows: catalog gives the admin UI a discoverable entry with the
 * gateway's allocation class (`gateway`), endpoint, and exposed tool list.
 * Credentials follow Phase 4 conventions — the secret never lands in the
 * DB; only the env var name is recorded so operators can rotate it.
 */
export async function registerMCPGatewayInCatalog(
  db: DatabaseAdapter,
  opts: RegisterMCPGatewayInCatalogOptions = {},
): Promise<{ catalogId: string; credentialId: string }> {
  const tools = opts.tools ?? BUILTIN_TOOLS;
  const classes = opts.exposedClasses ?? DEFAULT_EXPOSED_ALLOCATION_CLASSES;
  const exposed = selectExposedTools(tools, classes);
  const endpoint = opts.endpoint ?? '/api/mcp/gateway';
  const envVarName = opts.envVarName ?? MCP_GATEWAY_DEFAULT_ENV_VAR;
  const toolKey = opts.toolKey ?? MCP_GATEWAY_TOOL_KEY;
  const credentialName = opts.credentialName ?? MCP_GATEWAY_CREDENTIAL_NAME;

  // 1) Upsert the credential row (find by name since there is no unique key on env_var_name).
  const allCreds = await db.listToolCredentials();
  const existingCred = allCreds.find((c) => c.name === credentialName) ?? null;
  let credentialId: string;
  const credentialFields = {
    name: credentialName,
    description: 'Bearer token for the internal MCP gateway. Set the env var to enable the gateway.',
    credential_type: 'api_key',
    tool_names: JSON.stringify([toolKey]),
    env_var_name: envVarName,
    config: JSON.stringify({ headerName: 'Authorization', prefix: 'Bearer' }),
    rotation_due_at: null,
    validation_status: 'unknown',
    enabled: 1,
  } as const;
  if (existingCred) {
    credentialId = existingCred.id;
    await db.updateToolCredential(credentialId, credentialFields);
  } else {
    credentialId = randomUUID();
    await db.createToolCredential({ id: credentialId, ...credentialFields });
  }

  // 2) Upsert the catalog row keyed by tool_key.
  const exposedToolKeys = exposed.map((e) => e.key);
  const config = JSON.stringify({
    endpoint,
    server_name: 'geneweave-gateway',
    auth_scheme: 'Bearer',
    exposed_classes: [...classes].sort(),
    exposed_tool_keys: exposedToolKeys,
  });
  const description =
    'Internal MCP Streamable HTTP gateway exposing GeneWeave external builtin tools ' +
    `(${[...classes].sort().join(', ')}). ` +
    `Surfaces ${exposedToolKeys.length} tool(s) behind a bearer-token authenticated endpoint.`;
  const existingCatalog = await db.getToolCatalogByKey(toolKey);
  // Phase 4: on update, preserve operator-edited fields (`enabled` toggle
  // and `config.exposed_classes`) so admin changes survive restart. Only
  // refresh derived metadata (description, exposed_tool_keys against the
  // operator's class selection, endpoint when explicitly overridden).
  let catalogId: string;
  if (existingCatalog) {
    catalogId = existingCatalog.id;
    let mergedConfig = config;
    let effectiveClasses = classes;
    try {
      const prev = existingCatalog.config ? JSON.parse(existingCatalog.config) : {};
      if (Array.isArray(prev['exposed_classes']) && prev['exposed_classes'].length > 0) {
        effectiveClasses = new Set<string>(prev['exposed_classes'].map((c: unknown) => String(c)));
        const operatorExposed = selectExposedTools(tools, effectiveClasses);
        const merged = JSON.parse(config) as Record<string, unknown>;
        merged['exposed_classes'] = [...effectiveClasses].sort();
        merged['exposed_tool_keys'] = operatorExposed.map((e) => e.key);
        mergedConfig = JSON.stringify(merged);
      }
    } catch {
      // Malformed prior config — fall back to code-defined defaults.
    }
    await db.updateToolConfig(catalogId, {
      name: 'GeneWeave MCP Gateway',
      description,
      category: 'mcp',
      risk_level: 'external-side-effect',
      requires_approval: 0,
      max_execution_ms: null,
      rate_limit_per_min: null,
      enabled: existingCatalog.enabled, // preserve operator toggle
      tool_key: toolKey,
      version: '1.0',
      side_effects: 1,
      tags: JSON.stringify(['mcp', 'gateway', 'external']),
      source: 'mcp',
      credential_id: credentialId,
      config: mergedConfig,
      allocation_class: 'gateway',
    });
  } else {
    catalogId = randomUUID();
    await db.createToolConfig({
      id: catalogId,
      name: 'GeneWeave MCP Gateway',
      description,
      category: 'mcp',
      risk_level: 'external-side-effect',
      requires_approval: 0,
      max_execution_ms: null,
      rate_limit_per_min: null,
      enabled: 1,
      tool_key: toolKey,
      version: '1.0',
      side_effects: 1,
      tags: JSON.stringify(['mcp', 'gateway', 'external']),
      source: 'mcp',
      credential_id: credentialId,
      config,
      allocation_class: 'gateway',
    });
  }

  return { catalogId, credentialId };
}

/**
 * Snapshot of the gateway's runtime configuration as resolved from the
 * operator-managed `tool_catalog` row at startup. Phase 4: lets operators
 * toggle the gateway and adjust which allocation classes it exposes
 * without a code change.
 */
export interface LoadedGatewayConfig {
  /** True when the operator has not disabled the gateway in tool_catalog. */
  enabled: boolean;
  /** Allocation classes to expose (operator-edited or code defaults). */
  exposedClasses: ReadonlySet<string>;
  /** Endpoint path recorded in the catalog row (defaults to /api/mcp/gateway). */
  endpoint: string;
}

/**
 * Read the gateway catalog row and return a runtime config snapshot.
 * Falls back to {@link DEFAULT_EXPOSED_ALLOCATION_CLASSES} and `enabled=true`
 * when the catalog row is missing (first boot before {@link registerMCPGatewayInCatalog}
 * has run, or in tests using an empty DB).
 */
export async function loadGatewayConfigFromCatalog(
  db: DatabaseAdapter,
  toolKey: string = MCP_GATEWAY_TOOL_KEY,
): Promise<LoadedGatewayConfig> {
  const row = await db.getToolCatalogByKey(toolKey);
  if (!row) {
    return {
      enabled: true,
      exposedClasses: DEFAULT_EXPOSED_ALLOCATION_CLASSES,
      endpoint: '/api/mcp/gateway',
    };
  }
  let exposedClasses: ReadonlySet<string> = DEFAULT_EXPOSED_ALLOCATION_CLASSES;
  let endpoint = '/api/mcp/gateway';
  try {
    const cfg = (row.config ? JSON.parse(row.config) : {}) as Record<string, unknown>;
    const ec = cfg['exposed_classes'];
    if (Array.isArray(ec) && ec.length > 0) {
      exposedClasses = new Set<string>(ec.map((c) => String(c)));
    }
    const ep = cfg['endpoint'];
    if (typeof ep === 'string' && ep.length > 0) endpoint = ep;
  } catch {
    // Malformed config JSON — keep defaults.
  }
  return { enabled: row.enabled === 1, exposedClasses, endpoint };
}
