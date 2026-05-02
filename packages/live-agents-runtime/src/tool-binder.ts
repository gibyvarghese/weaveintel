/**
 * Tool Binder — Phase 3 of the DB-driven live-agents runtime.
 *
 * Resolves the **per-agent** tool surface from the database, replacing
 * geneweave's hardcoded `KAGGLE_CAPABILITY_MATRIX` and per-domain
 * `createKaggleTools()` factory.
 *
 * Strategy:
 *   1. Read every enabled `live_agent_tool_bindings` row for the agent.
 *   2. For each binding pointing at a `tool_catalog_id`, fetch the catalog
 *      row via the supplied DB facade.
 *   3. For each binding that only specifies an `mcp_server_url`, synthesise
 *      an inline `ToolCatalogRow`-shaped record with `source = 'mcp'` and
 *      `config = { endpoint }` so downstream code (e.g. geneweave's
 *      `createToolRegistry`) can connect without any extra branching.
 *
 * The binder deliberately returns plain data — it never builds the
 * `ToolRegistry` itself. That responsibility stays in the geneweave bridge
 * (`apps/geneweave/src/live-agents/agent-tool-registry.ts`) which already
 * owns the canonical `createToolRegistry` factory plus its policy /
 * credential / audit wiring.
 *
 * The exported DB facade interfaces are intentionally narrow: the runtime
 * package never imports the full geneweave `DatabaseAdapter`. Any caller
 * (test fixture, in-memory mock, real SQLite) just has to implement these
 * three methods.
 */

/**
 * Minimal shape of a `live_agent_tool_bindings` row that the binder needs.
 * Mirrors `LiveAgentToolBindingRow` in geneweave but kept structurally typed
 * so callers can use their own row type without any mapping.
 */
export interface AgentToolBindingRowLike {
  id: string;
  agent_id: string;
  tool_catalog_id: string | null;
  mcp_server_url: string | null;
  /** JSON-encoded `string[]`. `[]` (or empty) means "all capabilities". */
  capability_keys: string;
  enabled: number;
}

/**
 * Minimal shape of a `tool_catalog` row that the binder needs to forward to
 * `createToolRegistry({ catalogEntries })`. The geneweave `ToolCatalogRow`
 * is structurally compatible with this contract.
 */
export interface ToolCatalogRowLike {
  id: string;
  name: string;
  description: string | null;
  tool_key: string | null;
  source: string;                  // 'builtin' | 'custom' | 'mcp' | 'a2a' | 'plugin'
  enabled: number;
  config?: string | null;          // JSON
  credential_id: string | null;
  risk_level?: string;
  tags?: string | null;
  // Other catalog fields are passed through opaquely by callers when needed.
  // No index signature on purpose: lets concrete row types like geneweave's
  // `ToolCatalogRow` (which lack an index signature) satisfy this contract
  // without an explicit cast.
}

/**
 * Narrow DB facade the binder depends on. Keep it small so the runtime
 * package stays decoupled from geneweave's full adapter surface.
 */
export interface AgentToolBindingDb {
  listLiveAgentToolBindings(opts?: {
    agentId?: string;
    enabledOnly?: boolean;
  }): Promise<AgentToolBindingRowLike[]>;
  getToolConfig(id: string): Promise<ToolCatalogRowLike | null>;
}

/** Result of resolving an agent's tool bindings. */
export interface ResolvedAgentTools {
  /** Tool-catalog rows (real or synthesised) the agent is allowed to use. */
  catalogEntries: ToolCatalogRowLike[];
  /**
   * Tool keys to explicitly enable when those entries reference built-in
   * tools (`source === 'builtin'`). Caller passes these as the first arg of
   * `createToolRegistry`.
   */
  builtinToolKeys: string[];
  /** Per-binding capability key allow-lists (binding id → keys). */
  capabilityKeysByBinding: Record<string, string[]>;
  /** Non-fatal errors collected per binding (binding id → message). */
  warnings: Array<{ bindingId: string; message: string }>;
}

/**
 * Synthesise an inline catalog row for a binding that only specifies
 * `mcp_server_url`. The id is derived from the binding so duplicate URLs
 * across agents stay distinct.
 */
function synthesiseMcpCatalogRow(
  binding: AgentToolBindingRowLike,
): ToolCatalogRowLike {
  const url = binding.mcp_server_url ?? '';
  return {
    id: `inline-mcp:${binding.id}`,
    name: `mcp:${url}`,
    description: `Inline MCP server bound to agent ${binding.agent_id}`,
    tool_key: null,
    source: 'mcp',
    enabled: 1,
    config: JSON.stringify({ endpoint: url }),
    credential_id: null,
    risk_level: 'external-side-effect',
    tags: JSON.stringify(['mcp', 'inline-binding']),
  };
}

function safeParseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Read every enabled binding for `agentId` and resolve catalog rows. MCP
 * URL bindings are returned as inline synthesised rows so the caller treats
 * them uniformly with operator-managed catalog entries.
 *
 * Disabled bindings, dangling `tool_catalog_id` references, and bindings
 * with neither a catalog id nor a URL are skipped (and recorded in
 * `warnings`) instead of throwing — the binder is safe to call even when
 * the operator's data is partially broken.
 */
export async function resolveAgentToolCatalog(
  db: AgentToolBindingDb,
  agentId: string,
): Promise<ResolvedAgentTools> {
  const bindings = await db.listLiveAgentToolBindings({ agentId, enabledOnly: true });

  const catalogEntries: ToolCatalogRowLike[] = [];
  const builtinToolKeys: string[] = [];
  const capabilityKeysByBinding: Record<string, string[]> = {};
  const warnings: Array<{ bindingId: string; message: string }> = [];

  for (const binding of bindings) {
    capabilityKeysByBinding[binding.id] = safeParseJsonArray(binding.capability_keys);

    if (binding.tool_catalog_id) {
      const catalogRow = await db.getToolConfig(binding.tool_catalog_id);
      if (!catalogRow) {
        warnings.push({
          bindingId: binding.id,
          message: `tool_catalog_id ${binding.tool_catalog_id} not found`,
        });
        continue;
      }
      if (!catalogRow.enabled) {
        warnings.push({
          bindingId: binding.id,
          message: `tool_catalog row ${catalogRow.name} is disabled`,
        });
        continue;
      }
      catalogEntries.push(catalogRow);
      // Built-in catalog entries select a registered BUILTIN_TOOLS key by
      // tool_key; surface it so the caller can pass it via toolNames.
      if (catalogRow.source === 'builtin' && catalogRow.tool_key) {
        builtinToolKeys.push(catalogRow.tool_key);
      }
      continue;
    }

    if (binding.mcp_server_url) {
      catalogEntries.push(synthesiseMcpCatalogRow(binding));
      continue;
    }

    warnings.push({
      bindingId: binding.id,
      message: 'binding has neither tool_catalog_id nor mcp_server_url',
    });
  }

  return { catalogEntries, builtinToolKeys, capabilityKeysByBinding, warnings };
}
