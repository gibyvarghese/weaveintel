/**
 * @weaveintel/geneweave — Built-in tools & registry
 *
 * Ships a set of useful built-in tools that agents can use, plus
 * a helper to create a ToolRegistry from selected tool names.
 */

import type { Tool, ToolRegistry } from '@weaveintel/core';
import { weaveTool, weaveToolRegistry } from '@weaveintel/core';
import { createPolicyEnforcedRegistry, type ToolPolicyResolver, type ToolAuditEmitter, type ToolRateLimiter, noopAuditEmitter } from '@weaveintel/tools';
import { Buffer } from 'node:buffer';
import { createSearchRouter, type SearchProviderConfig } from '@weaveintel/tools-search';
import { createInMemoryTemporalStore, createTimeTools, type TemporalStore } from '@weaveintel/tools-time';
import { createBrowserTools, createAutomationTools, createBrowserAuthTools } from '@weaveintel/tools-browser';
import { statsNzToolMap } from '@weaveintel/tools-http';
import { canUseTool, normalizePersona } from './rbac.js';
import type { ExecutionLanguage } from '@weaveintel/sandbox';
import { getCSE } from './cse.js';
import type { DatabaseAdapter } from './db.js';
import { weaveMCPClient, weaveMCPTools } from '@weaveintel/mcp-client';
import { weaveA2AClient } from '@weaveintel/a2a';
import { createSVToolMap } from './features/scientific-validation/tools/index.js';

interface RuntimeAttachment {
  name: string;
  mimeType: string;
  size: number;
  dataBase64?: string;
  transcript?: string;
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function isBrowserAutomationEnabledByEnv(): boolean {
  return envFlag('GENEWEAVE_ENABLE_BROWSER_AUTOMATION', true)
    && (Boolean(process.env['PLAYWRIGHT_BROWSER_PATH']) || envFlag('PLAYWRIGHT_AUTOMATION_ENABLED', false));
}

function tokenizeExpression(expression: string): string[] {
  const sanitized = expression.replace(/\^/g, '**').replace(/\s+/g, '');
  if (!sanitized || sanitized.length > 200) throw new Error('Invalid expression');
  if (/[^0-9+\-*/.%()]/.test(sanitized)) throw new Error('Expression contains unsupported characters');

  const tokens = sanitized.match(/\*\*|\d+(?:\.\d+)?|[()+\-*/%]/g);
  if (!tokens || tokens.join('') !== sanitized) throw new Error('Expression could not be parsed');
  return tokens;
}

function evaluateExpression(expression: string): number {
  const tokens = tokenizeExpression(expression);
  const values: number[] = [];
  const operators: string[] = [];
  const precedence = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '**': 3 } as const;
  const rightAssociative = new Set(['**']);
  const isOperator = (value: string): value is keyof typeof precedence => Object.prototype.hasOwnProperty.call(precedence, value);

  const applyOperator = () => {
    const op = operators.pop();
    if (!op) throw new Error('Malformed expression');
    if (op === '(') throw new Error('Mismatched parentheses');
    const right = values.pop();
    const left = values.pop();
    if (right == null || left == null) throw new Error('Malformed expression');
    switch (op) {
      case '+': values.push(left + right); break;
      case '-': values.push(left - right); break;
      case '*': values.push(left * right); break;
      case '/':
        if (right === 0) throw new Error('Division by zero');
        values.push(left / right);
        break;
      case '%':
        if (right === 0) throw new Error('Division by zero');
        values.push(left % right);
        break;
      case '**': values.push(left ** right); break;
      default: throw new Error('Unsupported operator');
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const previous = index > 0 ? tokens[index - 1] : undefined;
    const previousIsOperator = previous != null && isOperator(previous);
    const unary = token === '-' && (index === 0 || previous === '(' || previousIsOperator);

    if (unary) {
      const next = tokens[index + 1];
      if (next == null || !/^\d/.test(next)) throw new Error('Unary minus must precede a number');
      values.push(-Number(next));
      index += 1;
      continue;
    }

    if (/^\d/.test(token)) {
      values.push(Number(token));
      continue;
    }
    if (token === '(') {
      operators.push(token);
      continue;
    }
    if (token === ')') {
      while (operators.length > 0 && operators[operators.length - 1] !== '(') applyOperator();
      if (operators.pop() !== '(') throw new Error('Mismatched parentheses');
      continue;
    }
    if (!isOperator(token)) throw new Error('Unsupported operator');

    while (operators.length > 0) {
      const top = operators[operators.length - 1]!;
      if (top === '(') break;
      if (!isOperator(top)) throw new Error('Unsupported operator');
      const shouldApply = rightAssociative.has(token)
        ? precedence[top] > precedence[token]
        : precedence[top] >= precedence[token];
      if (!shouldApply) break;
      applyOperator();
    }
    operators.push(token);
  }

  while (operators.length > 0) applyOperator();
  if (values.length !== 1 || !Number.isFinite(values[0]!)) throw new Error('Malformed expression');
  return values[0]!;
}

function buildSearchProviderConfigs(): Record<string, SearchProviderConfig> {
  const tavilyApiKey = process.env['TAVILY_API_KEY'];
  const braveApiKey = process.env['BRAVE_SEARCH_API_KEY'] ?? process.env['BRAVE_API_KEY'];

  return {
    // Default free provider with no API key requirement.
    duckduckgo: {
      name: 'duckduckgo',
      enabled: envFlag('SEARCH_DUCKDUCKGO_ENABLED', true),
      priority: Number(process.env['SEARCH_DUCKDUCKGO_PRIORITY'] ?? 50),
      options: {
        safesearch: process.env['SEARCH_DUCKDUCKGO_SAFESEARCH'] ?? 'moderate',
        region: process.env['SEARCH_DUCKDUCKGO_REGION'] ?? 'wt-wt',
      },
    },
    tavily: {
      name: 'tavily',
      enabled: envFlag('SEARCH_TAVILY_ENABLED', Boolean(tavilyApiKey)),
      apiKey: tavilyApiKey,
      priority: Number(process.env['SEARCH_TAVILY_PRIORITY'] ?? 30),
      options: {
        depth: process.env['SEARCH_TAVILY_DEPTH'] ?? 'basic',
      },
    },
    brave: {
      name: 'brave',
      enabled: envFlag('SEARCH_BRAVE_ENABLED', Boolean(braveApiKey)),
      apiKey: braveApiKey,
      priority: Number(process.env['SEARCH_BRAVE_PRIORITY'] ?? 40),
    },
  };
}

// ─── Built-in tools ─────────────────────────────────────────

// Each tool below uses weaveTool() from @weaveintel/core to create
// a schema-validated, tagable tool. The ChatEngine’s agent mode picks
// tools from the ToolRegistry to inject into the agent’s ReAct loop.
// In direct mode they are listed in the UI for user reference.─

const calculatorTool = weaveTool({
  name: 'calculator',
  description: 'Evaluate a mathematical expression. Supports +, -, *, /, **, %, parentheses.',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'The math expression to evaluate' },
    },
    required: ['expression'],
  },
  execute: async (args: { expression: string }) => {
    try {
      const result = evaluateExpression(args.expression);
      return String(result);
    } catch (e) {
      return { content: `Error: ${(e as Error).message}`, isError: true };
    }
  },
  tags: ['math', 'utility'],
});

const defaultTemporalStore = createInMemoryTemporalStore();

function createTimeToolMap(defaultTimezone?: string, temporalStore: TemporalStore = defaultTemporalStore): Record<string, Tool> {
  const timeTools = createTimeTools({ defaultTimezone, store: temporalStore });
  return Object.fromEntries(timeTools.map((tool) => [tool.schema.name, tool]));
}

const webSearchTool = weaveTool({
  name: 'web_search',
  description: 'Search the web using configured providers (DuckDuckGo, Tavily, Brave).',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      limit: { type: 'number', description: 'Maximum number of results (default: 5, max: 10)' },
      provider: { type: 'string', description: 'Optional provider override (duckduckgo|tavily|brave)' },
      language: { type: 'string', description: 'Optional language hint (e.g. en)' },
      safeSearch: { type: 'boolean', description: 'Optional safesearch preference' },
    },
    required: ['query'],
  },
  execute: async (args: { query: string; limit?: number; provider?: string; language?: string; safeSearch?: boolean }) => {
    const configs = buildSearchProviderConfigs();
    const hasEnabledProvider = Object.values(configs).some((cfg) => cfg.enabled);
    if (!hasEnabledProvider) {
      return JSON.stringify({
        query: args.query,
        provider: 'none',
        error: 'No search providers are enabled. Enable at least one provider via environment variables.',
        results: [],
      }, null, 2);
    }

    const router = createSearchRouter({ configs, fallback: true });
    const limit = Math.max(1, Math.min(10, Number(args.limit ?? 5)));

    const routed = args.provider
      ? await router.searchWith(args.provider, {
          query: args.query,
          limit,
          language: args.language,
          safeSearch: args.safeSearch,
        })
      : await router.search({
          query: args.query,
          limit,
          language: args.language,
          safeSearch: args.safeSearch,
        });

    return JSON.stringify({
      query: args.query,
      provider: routed.provider,
      latencyMs: routed.latencyMs,
      error: routed.error,
      resultCount: routed.results.length,
      results: routed.results.map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        source: result.source,
        publishedAt: result.publishedAt,
        score: result.score,
      })),
    }, null, 2);
  },
  tags: ['search', 'external'],
});

const jsonFormatterTool = weaveTool({
  name: 'json_format',
  description: 'Parse and pretty-print a JSON string.',
  parameters: {
    type: 'object',
    properties: {
      json: { type: 'string', description: 'The JSON string to format' },
      indent: { type: 'number', description: 'Indentation spaces (default: 2)' },
    },
    required: ['json'],
  },
  execute: async (args: { json: string; indent?: number }) => {
    try {
      const parsed = JSON.parse(args.json);
      return JSON.stringify(parsed, null, args.indent ?? 2);
    } catch (e) {
      return { content: `Invalid JSON: ${(e as Error).message}`, isError: true };
    }
  },
  tags: ['utility', 'formatting'],
});

const textAnalysisTool = weaveTool({
  name: 'text_analysis',
  description: 'Analyze text: word count, character count, sentence count, reading time.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The text to analyze' },
    },
    required: ['text'],
  },
  execute: async (args: { text: string }) => {
    const words = args.text.split(/\s+/).filter(Boolean).length;
    const chars = args.text.length;
    const sentences = args.text.split(/[.!?]+/).filter(Boolean).length;
    const readingTime = Math.ceil(words / 200);
    return JSON.stringify({ words, characters: chars, sentences, readingTimeMinutes: readingTime }, null, 2);
  },
  tags: ['utility', 'text'],
});

// ─── Tool catalog ───────────────────────────────────────────

// BUILTIN_TOOLS is an index of all shipped tools keyed by name.
// createToolRegistry() uses weaveToolRegistry() from @weaveintel/core,
// pre-loads selected built-in tools, and optionally adds custom tools.
// This is how the ChatEngine builds the per-chat tool set.─

function browserToolMap(): Record<string, Tool> {
  const browserTools = [...createBrowserTools()];
  if (isBrowserAutomationEnabledByEnv()) {
    browserTools.push(...createAutomationTools(), ...createBrowserAuthTools());
  }
  return Object.fromEntries(browserTools.map(t => [t.schema.name, t]));
}

function cseToolMap(opts?: ToolRegistryOptions): Record<string, Tool> {
  const runCode = weaveTool({
    name: 'cse_run_code',
    description: 'Run Python/JavaScript/bash code in the Compute Sandbox Engine. Starts or reuses a container session scoped to the current user and chat.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Code to execute in the sandbox.' },
        language: { type: 'string', enum: ['python', 'javascript', 'typescript', 'bash', 'shell'], description: 'Execution language. Default: python.' },
        chatId: { type: 'string', description: 'Optional chat ID. Defaults to current chat context.' },
        timeoutMs: { type: 'number', description: 'Optional execution timeout in milliseconds.' },
        networkAccess: { type: 'boolean', description: 'Allow outbound network access for this run.' },
      },
      required: ['code'],
    },
    execute: async (args: { code: string; language?: ExecutionLanguage; chatId?: string; timeoutMs?: number; networkAccess?: boolean }) => {
      const cse = await getCSE();
      if (!cse) return { content: 'CSE is not configured in this environment.', isError: true };
      const chatId = args.chatId ?? opts?.currentChatId;
      const files = (opts?.currentAttachments ?? []).flatMap((attachment) => {
        const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || `attachment-${Date.now()}`;
        const lowerMime = attachment.mimeType.toLowerCase();
        const isText =
          lowerMime.startsWith('text/') ||
          lowerMime === 'application/json' ||
          lowerMime === 'application/xml' ||
          lowerMime === 'application/javascript' ||
          lowerMime === 'application/x-javascript' ||
          lowerMime === 'application/csv' ||
          lowerMime.includes('markdown');

        const built: Array<{ name: string; content: string; binary?: boolean }> = [];
        if (attachment.dataBase64) {
          if (isText) {
            try {
              built.push({
                name: safeName,
                content: Buffer.from(attachment.dataBase64, 'base64').toString('utf8'),
                binary: false,
              });
            } catch {
              // Skip malformed base64 payloads.
            }
          } else {
            built.push({ name: safeName, content: attachment.dataBase64, binary: true });
          }
        }

        if (attachment.transcript) {
          built.push({
            name: `${safeName}.transcript.txt`,
            content: attachment.transcript,
            binary: false,
          });
        }

        return built;
      });
      const result = await cse.run({
        code: args.code,
        language: args.language,
        userId: opts?.currentUserId,
        chatId,
        files: files.length > 0 ? files : undefined,
        timeoutMs: args.timeoutMs,
        networkAccess: args.networkAccess,
      });
      return JSON.stringify({
        status: result.status,
        userId: opts?.currentUserId,
        chatId,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
        sessionId: result.sessionId,
        provider: result.providerInfo.provider,
      }, null, 2);
    },
    tags: ['sandbox', 'compute', 'code'],
  });

  const sessionStatus = weaveTool({
    name: 'cse_session_status',
    description: 'Get sandbox session status for the current user and chat.',
    parameters: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'Optional chat ID. Defaults to current chat context.' },
      },
      required: [],
    },
    execute: async (args: { chatId?: string }) => {
      const cse = await getCSE();
      if (!cse) return { content: 'CSE is not configured in this environment.', isError: true };
      const chatId = args.chatId ?? opts?.currentChatId;
      const session = cse.listSessions().find((s) => s.chatId === chatId && s.userId === opts?.currentUserId);
      return JSON.stringify({ active: Boolean(session), session: session ?? null }, null, 2);
    },
    tags: ['sandbox', 'session'],
  });

  const endSession = weaveTool({
    name: 'cse_end_session',
    description: 'Terminate sandbox session for the current user and chat.',
    parameters: {
      type: 'object',
      properties: {
        chatId: { type: 'string', description: 'Optional chat ID. Defaults to current chat context.' },
      },
      required: [],
    },
    execute: async (args: { chatId?: string }) => {
      const cse = await getCSE();
      if (!cse) return { content: 'CSE is not configured in this environment.', isError: true };
      const chatId = args.chatId ?? opts?.currentChatId;
      if (!chatId) return { content: 'No chatId available to terminate a session.', isError: true };
      await cse.terminateChatSession(chatId, opts?.currentUserId);
      return JSON.stringify({ terminated: true, chatId }, null, 2);
    },
    tags: ['sandbox', 'session'],
  });

  return {
    cse_run_code: runCode,
    cse_session_status: sessionStatus,
    cse_end_session: endSession,
  };
}

export const BUILTIN_TOOLS: Record<string, Tool> = {
  calculator: calculatorTool,
  ...createTimeToolMap(),
  web_search: webSearchTool,
  json_format: jsonFormatterTool,
  text_analysis: textAnalysisTool,
  ...browserToolMap(),
  ...cseToolMap(),
  ...statsNzToolMap(),
  ...createSVToolMap(),
};

/**
 * Sync BUILTIN_TOOLS into the tool_catalog table so operators can manage them
 * via the admin panel. Called once at startup via startGeneWeave / index.ts.
 * Uses upsert-by-tool_key so re-runs are safe and idempotent.
 */
export async function syncToolCatalog(db: DatabaseAdapter): Promise<void> {
  const { randomUUID } = await import('node:crypto');
  for (const [key, tool] of Object.entries(BUILTIN_TOOLS)) {
    const existing = await db.getToolCatalogByKey(key);
    if (!existing) {
      const riskLevel = tool.schema.riskLevel ?? 'read-only';
      const hasSideEffects = riskLevel !== 'read-only' ? 1 : 0;
      await db.createToolConfig({
        id: randomUUID(),
        name: tool.schema.name,
        description: tool.schema.description,
        category: (tool.schema.tags?.[0] ?? null) as string | null,
        risk_level: riskLevel,
        requires_approval: tool.schema.requiresApproval ? 1 : 0,
        max_execution_ms: null,
        rate_limit_per_min: null,
        enabled: 1,
        tool_key: key,
        version: '1.0',
        side_effects: hasSideEffects,
        tags: tool.schema.tags ? JSON.stringify(tool.schema.tags) : null,
        source: 'builtin',
        credential_id: null,
      });
    }
  }
}

export interface ToolRegistryOptions {
  defaultTimezone?: string;
  temporalStore?: TemporalStore;
  currentUserId?: string;
  currentChatId?: string;
  currentAttachments?: RuntimeAttachment[];
  actorPersona?: string;
  memoryRecall?: (args: { userId: string; query: string; limit?: number }) => Promise<{
    semantic: Array<{ content: string; source: string }>;
    entities: Array<{ entityType: string; entityName: string; facts: Record<string, unknown> }>;
  }>;
  /** Tool keys disabled in the operator-managed catalog. Populated from db.listEnabledToolCatalog(). */
  disabledToolKeys?: ReadonlySet<string>;
  /** Policy resolver for Phase 2 enforcement (rate limits, approval gates, risk level gates). */
  policyResolver?: ToolPolicyResolver;
  /** Audit emitter for recording tool invocation outcomes. */
  auditEmitter?: ToolAuditEmitter;
  /** Rate limiter for per-tool, per-scope limiting. */
  rateLimiter?: ToolRateLimiter;  /**
   * Phase 4: Resolve a credential by ID from the operator-managed tool_credentials table.
   * Returns null if not found or not enabled. Used to inject API key overrides for catalog-
   * linked tools (e.g. web_search with a Tavily key bound via credential_id).
   */
  credentialResolver?: (credentialId: string) => Promise<import('./db-types.js').ToolCredentialRow | null>;
  /**
   * Phase 4: Enabled catalog entries from db.listEnabledToolCatalog(). Used to load
   * MCP and A2A tool sources into the registry at runtime.
   */
  catalogEntries?: import('./db-types.js').ToolCatalogRow[];
  /**
   * Phase 6: Approval gate that checks/creates tool_approval_requests before allowing
   * execution of tools that require operator approval per their policy.
   */
  approvalGate?: import('@weaveintel/tools').ToolApprovalGate;
  /**
   * Phase 6: Active skill's tool_policy_key, propagated from the top-matched skill
   * via discoverSkillsForInput(). Overrides the global tool policy when set.
   */
  skillPolicyKey?: string;}

export function filterToolNamesByPersona(toolNames: string[], persona: string | null | undefined): string[] {
  return toolNames.filter((toolName) => canUseTool(persona, toolName));
}

// ─── Phase 4: MCP HTTP transport factory ──────────────────────
// Creates a minimal HTTP-based MCPTransport that sends JSON-RPC requests
// via POST to the given endpoint, optionally injecting a credential header.
function createHttpMCPTransport(
  endpoint: string,
  credentialResolver?: (id: string) => Promise<import('./db-types.js').ToolCredentialRow | null>,
  credentialId?: string,
): import('@weaveintel/core').MCPTransport {
  let messageHandler: ((msg: unknown) => void) | null = null;

  async function resolveAuthHeader(): Promise<Record<string, string>> {
    if (!credentialId || !credentialResolver) return {};
    const cred = await credentialResolver(credentialId);
    if (!cred?.enabled) return {};
    const cfg = cred.config ? (JSON.parse(cred.config) as { headerName?: string; prefix?: string }) : {};
    const envValue = process.env[cred.env_var_name ?? ''];
    if (!envValue) return {};
    const headerName = cfg.headerName ?? 'Authorization';
    const prefix = cfg.prefix ?? 'Bearer ';
    return { [headerName]: `${prefix}${envValue}` };
  }

  return {
    type: 'http',
    async send(message: unknown): Promise<void> {
      const authHeaders = await resolveAuthHeader();
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(message),
      });
      if (res.ok) {
        const data: unknown = await res.json();
        messageHandler?.(data);
      }
    },
    onMessage(handler: (message: unknown) => void): void {
      messageHandler = handler;
    },
    async close(): Promise<void> { /* HTTP is stateless, nothing to close */ },
  };
}

// ─── Phase 4: A2A delegate tool factory ───────────────────────
// Wraps an A2A agent URL as a tool that delegates work via weaveA2AClient.
function buildA2ATool(toolKey: string, description: string, agentUrl: string): import('@weaveintel/core').Tool {
  return weaveTool({
    name: toolKey,
    description,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task to delegate to the remote A2A agent' },
        context: { type: 'object', description: 'Optional context key-values to pass with the task' },
      },
      required: ['task'],
    },
    execute: async (args: { task: string; context?: Record<string, unknown> }) => {
      const client = weaveA2AClient();
      const result = await client.sendTask(
        { executionId: crypto.randomUUID(), metadata: args.context ?? {} },
        agentUrl,
        { id: crypto.randomUUID(), input: { role: 'user', parts: [{ type: 'text', text: args.task }] } },
      );
      if (result.error) return { content: `A2A error: ${result.error}`, isError: true };
      const textParts = (result.output?.parts ?? [])
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      return textParts || JSON.stringify(result);
    },
    tags: ['a2a', 'external'],
  });
}

/**
 * Create a ToolRegistry pre-loaded with the selected built-in tools
 * plus any custom tools provided.
 */
export async function createToolRegistry(toolNames: string[], customTools?: Tool[], opts?: ToolRegistryOptions): Promise<ToolRegistry> {
  const registry = weaveToolRegistry();
  const actorPersona = opts?.actorPersona;
  const memoryRecallTool = weaveTool({
    name: 'memory_recall',
    description: 'Retrieve relevant long-term memory for the current user from semantic and entity memory stores.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall from memory for this user' },
        limit: { type: 'number', description: 'Max semantic memories to return (default: 5, max: 20)' },
      },
      required: ['query'],
    },
    execute: async (args: { query: string; limit?: number }) => {
      if (!opts?.memoryRecall || !opts.currentUserId) {
        return {
          content: 'Memory recall is unavailable in this execution context.',
          isError: true,
        };
      }
      const limit = Math.max(1, Math.min(20, Number(args.limit ?? 5)));
      const recalled = await opts.memoryRecall({
        userId: opts.currentUserId,
        query: args.query,
        limit,
      });
      return JSON.stringify({
        query: args.query,
        semanticCount: recalled.semantic.length,
        entityCount: recalled.entities.length,
        semantic: recalled.semantic,
        entities: recalled.entities,
      }, null, 2);
    },
    tags: ['memory', 'personalization'],
  });

  const scopedTools: Record<string, Tool> = {
    ...BUILTIN_TOOLS,
    ...createTimeToolMap(opts?.defaultTimezone, opts?.temporalStore ?? defaultTemporalStore),
    ...cseToolMap(opts),
    memory_recall: memoryRecallTool,
  };
  for (const name of filterToolNamesByPersona(toolNames, actorPersona)) {
    // Skip tools disabled in the operator-managed tool catalog
    if (opts?.disabledToolKeys && opts.disabledToolKeys.has(name)) continue;
    const tool = scopedTools[name];
    if (tool) registry.register(tool);
  }
  if (customTools) {
    for (const tool of customTools) {
      if (canUseTool(actorPersona, tool.schema.name)) {
        registry.register(tool);
      }
    }
  }

  // Phase 4: Load MCP and A2A tools from operator-managed catalog entries.
  if (opts?.catalogEntries && opts.catalogEntries.length > 0) {
    for (const entry of opts.catalogEntries) {
      if (!entry.enabled) continue;
      if (entry.source === 'mcp' && entry.config) {
        try {
          const mcpConfig = JSON.parse(entry.config) as { endpoint?: string; command?: string; args?: string[] };
          if (mcpConfig.endpoint) {
            // HTTP-based MCP transport
            const mcpTransport = createHttpMCPTransport(mcpConfig.endpoint, opts.credentialResolver, entry.credential_id ?? undefined);
            const mcpClient = weaveMCPClient();
            await mcpClient.connect(mcpTransport);
            const mcpToolDefs = await mcpClient.listTools();
            const mcpRegistry = weaveMCPTools(mcpClient, mcpToolDefs);
            for (const tool of mcpRegistry.list()) {
              if (canUseTool(actorPersona, tool.schema.name)) {
                registry.register(tool);
              }
            }
          }
        } catch {
          // Non-fatal: log and continue so a single broken MCP server doesn't block the request
        }
      } else if (entry.source === 'a2a' && entry.config) {
        try {
          const a2aConfig = JSON.parse(entry.config) as { agentUrl?: string };
          if (a2aConfig.agentUrl) {
            const a2aTool = buildA2ATool(entry.tool_key ?? entry.name, entry.description ?? entry.name, a2aConfig.agentUrl);
            if (canUseTool(actorPersona, a2aTool.schema.name)) {
              registry.register(a2aTool);
            }
          }
        } catch {
          // Non-fatal
        }
      }
    }
  }

  // Phase 2: wrap with policy enforcement when a resolver is provided.
  if (opts?.policyResolver) {
    return createPolicyEnforcedRegistry(registry, {
      resolver: opts.policyResolver,
      auditEmitter: opts.auditEmitter ?? noopAuditEmitter,
      rateLimiter: opts.rateLimiter,
      approvalGate: opts.approvalGate,
      resolutionContext: {
        agentPersona: opts.actorPersona,
        chatId: opts.currentChatId,
        userId: opts.currentUserId,
        skillPolicyKey: opts.skillPolicyKey,
      },
    });
  }

  return registry;
}

/** Info about all available built-in tools */
export function getAvailableTools(persona?: string | null): Array<{ name: string; description: string; tags: string[] }> {
  const effectivePersona = persona;
  const base = Object.values(BUILTIN_TOOLS).map((t) => ({
    name: t.schema.name,
    description: t.schema.description,
    tags: [...(t.schema.tags ?? [])],
  }));
  return [
    ...base,
    {
      name: 'memory_recall',
      description: 'Retrieve relevant long-term memory for the current user from semantic and entity memory stores.',
      tags: ['memory', 'personalization'],
    },
  ].filter((tool) => canUseTool(effectivePersona, tool.name));
}
