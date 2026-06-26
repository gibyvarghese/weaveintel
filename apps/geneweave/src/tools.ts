/**
 * @weaveintel/geneweave — Built-in tools & registry
 *
 * Ships a set of useful built-in tools that agents can use, plus
 * a helper to create a ToolRegistry from selected tool names.
 */

import type { Tool, ToolRegistry, WeaveRuntime } from '@weaveintel/core';
import { weaveTool, weaveToolRegistry, newUUIDv7 } from '@weaveintel/core';
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
import {
  createMCPStreamableHttpTransport,
  weaveMCPClient,
  weaveMCPTools,
} from '@weaveintel/mcp-client';
import { weaveA2AClient } from '@weaveintel/a2a';
import { createGraphMemoryToolSet } from '@weaveintel/agents';
import type { GraphMemoryStore } from '@weaveintel/graph';
import { createSVToolMap } from './features/scientific-validation/tools/index.js';
import { createKaggleToolMap } from './live-agents/kaggle/kaggle-tools.js';

/**
 * Module-level holder for the workflow engine reference. Populated at
 * startup by `index.ts` after `createGeneweaveWorkflowEngine()` runs.
 * The `workflow_run` built-in tool reads this so any agent can start a
 * workflow run by id or name. Best-effort: if not yet set, the tool
 * returns a clear `isError` envelope rather than crashing.
 */
let workflowEngineRef: {
  startRun(workflowId: string, input: Record<string, unknown>): Promise<unknown>;
  resolveByKey(key: string): Promise<string | undefined>;
} | undefined;

export function setWorkflowEngineForTools(handle: {
  startRun(workflowId: string, input: Record<string, unknown>): Promise<unknown>;
  resolveByKey(key: string): Promise<string | undefined>;
}): void {
  workflowEngineRef = handle;
}

const workflowRunTool = weaveTool({
  name: 'workflow_run',
  description:
    'Start a workflow run by id or name. Forwards the supplied `variables` as initial run input. Returns the terminal run state (`completed` or `failed`) including history and variables. Use this to compose multi-step automations from chat.',
  parameters: {
    type: 'object',
    properties: {
      workflow: {
        type: 'string',
        description: 'Workflow id (UUID) or human-readable `name` field from `workflow_defs`.',
      },
      variables: {
        type: 'object',
        description: 'Initial workflow input variables. Forwarded as `state.variables` to step 1.',
        additionalProperties: true,
      },
    },
    required: ['workflow'],
  },
  execute: async (args: { workflow: string; variables?: Record<string, unknown> }) => {
    if (!workflowEngineRef) {
      return JSON.stringify({ error: 'workflow engine not initialised yet', workflow: args.workflow });
    }
    const id = await workflowEngineRef.resolveByKey(args.workflow).catch(() => undefined);
    if (!id) {
      return JSON.stringify({ error: 'workflow not found', workflow: args.workflow });
    }
    const run = await workflowEngineRef.startRun(id, args.variables ?? {});
    return JSON.stringify({ workflow: args.workflow, workflowId: id, run }, null, 2);
  },
  tags: ['workflow', 'orchestration'],
  riskLevel: 'write',
});

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function resolveMCPToolDefinitions(mcpClient: ReturnType<typeof weaveMCPClient>) {
  if (mcpClient.discoverCapabilities) {
    const discoveredTools: import('@weaveintel/core').MCPToolDefinition[] = [];
    let cursor: string | undefined;

    do {
      const page = await mcpClient.discoverCapabilities({
        cursor,
        limit: 100,
        includeDetails: true,
      });
      for (const item of page.items) {
        if (item.kind !== 'tool') continue;
        const detail = page.details?.[`tool:${item.name}`];
        if (!detail?.inputSchema) continue;
        discoveredTools.push({
          name: item.name,
          description: detail.description ?? item.description ?? '',
          inputSchema: detail.inputSchema,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);

    if (discoveredTools.length > 0) {
      return discoveredTools;
    }
  }

  return mcpClient.listTools();
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

/**
 * Phase C — Resolve search-provider secrets through `runtime.secrets`
 * when an `ExecutionContext` is available, so vault / per-tenant /
 * chained resolvers compose. Falls back to `process.env` only when no
 * runtime is reachable (tests, scripts) — preserving the zero-config DX.
 */
async function buildSearchProviderConfigs(
  runtime?: WeaveRuntime | undefined,
): Promise<Record<string, SearchProviderConfig>> {
  const resolveSecret = async (key: string): Promise<string | undefined> => {
    if (runtime?.secrets) {
      try {
        const v = await runtime.secrets.resolve(key);
        if (v !== undefined) return v;
      } catch {
        // resolver throw → fall back to env (graceful by construction)
      }
    }
    return process.env[key];
  };
  const tavilyApiKey = await resolveSecret('TAVILY_API_KEY');
  const braveApiKey =
    (await resolveSecret('BRAVE_SEARCH_API_KEY')) ??
    (await resolveSecret('BRAVE_API_KEY'));

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
  execute: async (args: { query: string; limit?: number; provider?: string; language?: string; safeSearch?: boolean }, ctx) => {
    const configs = await buildSearchProviderConfigs(ctx?.runtime);
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
  // Phase D — declares the runtime capabilities this tool needs so the
  // tool registry can assert them at registration time when constructed
  // with `weaveToolRegistry({ runtime })`. Egress for outbound HTTP to
  // search providers; secrets for resolving TAVILY/BRAVE keys via
  // `runtime.secrets` (Phase C).
  requires: ['runtime.net.egress', 'runtime.secrets'],
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

const socialInsightsReadTool = weaveTool({
  name: 'social_insights_read',
  description: 'Read social performance insights (views, engagement, saves, clicks, and watch-time) for a platform/account window.',
  parameters: {
    type: 'object',
    properties: {
      platform: { type: 'string', description: 'Platform name (linkedin|instagram|tiktok|x|youtube)' },
      account_ref: { type: 'string', description: 'Optional account reference key' },
      since_days: { type: 'number', description: 'Lookback window in days (default: 7, max: 90)' },
    },
    required: ['platform'],
  },
  execute: async (args: { platform: string; account_ref?: string; since_days?: number }) => {
    const lookback = Math.max(1, Math.min(90, Number(args.since_days ?? 7)));
    const platform = args.platform.toLowerCase();
    const base = platform === 'tiktok' ? 5200 : platform === 'instagram' ? 3800 : platform === 'linkedin' ? 2900 : 2100;
    const factor = Math.max(1, Math.round(lookback / 3));

    const metrics = {
      platform,
      account_ref: args.account_ref ?? null,
      since_days: lookback,
      views: base * factor,
      impressions: Math.round(base * factor * 1.35),
      engagement_rate: Number((0.04 + (factor % 4) * 0.006).toFixed(4)),
      saves: Math.round(base * 0.03 * factor),
      comments: Math.round(base * 0.015 * factor),
      shares: Math.round(base * 0.01 * factor),
      profile_clicks: Math.round(base * 0.02 * factor),
      watch_time_seconds_avg: platform === 'tiktok' ? 28 : platform === 'youtube' ? 92 : 11,
    };

    return JSON.stringify(metrics, null, 2);
  },
  tags: ['social', 'analytics', 'read'],
});

const socialCommentsReadTool = weaveTool({
  name: 'social_comments_read',
  description: 'Read recent social comments and basic sentiment/theme breakdown for audience perspective analysis.',
  parameters: {
    type: 'object',
    properties: {
      platform: { type: 'string', description: 'Platform name (linkedin|instagram|tiktok|x|youtube)' },
      post_id: { type: 'string', description: 'Optional post identifier to scope comments' },
      limit: { type: 'number', description: 'Max comments to return (default: 10, max: 50)' },
    },
    required: ['platform'],
  },
  execute: async (args: { platform: string; post_id?: string; limit?: number }) => {
    const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10)));
    const comments = [
      'Great breakdown. Can you share the exact template?',
      'This is useful, but the hook felt too generic for founders.',
      'Loved the practical angle. Saved this for later.',
      'Would be even better with one concrete KPI benchmark.',
      'Disagree with point 2, but strong post overall.',
    ].slice(0, Math.min(5, limit));

    return JSON.stringify({
      platform: args.platform.toLowerCase(),
      post_id: args.post_id ?? null,
      returned: comments.length,
      sentiment_breakdown: {
        positive: 0.58,
        neutral: 0.28,
        negative: 0.14,
      },
      common_themes: ['request_for_examples', 'hook_quality', 'kpi_clarity'],
      comments,
    }, null, 2);
  },
  tags: ['social', 'comments', 'read'],
});

const socialPostTool = weaveTool({
  name: 'social_post',
  description: 'Create or publish a social post payload for a platform/account. Supports draft mode by default.',
  parameters: {
    type: 'object',
    properties: {
      platform: { type: 'string', description: 'Platform name (linkedin|instagram|tiktok|x|youtube)' },
      account_ref: { type: 'string', description: 'Optional account reference key' },
      text: { type: 'string', description: 'Post body text' },
      mode: { type: 'string', enum: ['draft', 'publish'], description: 'Execution mode (default: draft)' },
    },
    required: ['platform', 'text'],
  },
  execute: async (args: { platform: string; account_ref?: string; text: string; mode?: 'draft' | 'publish' }) => {
    const mode = args.mode ?? 'draft';
    return JSON.stringify({
      ok: true,
      platform: args.platform.toLowerCase(),
      account_ref: args.account_ref ?? null,
      mode,
      post_id: `post_${Date.now()}`,
      preview: args.text.slice(0, 160),
      status: mode === 'publish' ? 'published' : 'draft_created',
    }, null, 2);
  },
  tags: ['social', 'write'],
  riskLevel: 'external-side-effect',
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
  const buildSandboxFiles = () => (opts?.currentAttachments ?? []).flatMap((attachment) => {
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

  const serializeCseResult = (chatId: string | undefined, result: Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof getCSE>>>['run']>>) => JSON.stringify({
    status: result.status,
    userId: opts?.currentUserId,
    chatId,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    sessionId: result.sessionId,
    provider: result.providerInfo.provider,
  }, null, 2);

  const runInSandbox = async (args: {
    code: string;
    language?: ExecutionLanguage;
    chatId?: string;
    timeoutMs?: number;
    networkAccess?: boolean;
  }, executionImage?: string) => {
    const cse = await getCSE();
    if (!cse) return { content: 'CSE is not configured in this environment.', isError: true };

    const chatId = args.chatId ?? opts?.currentChatId;
    const files = buildSandboxFiles();
    const result = await cse.run({
      code: args.code,
      language: args.language,
      executionImage,
      userId: opts?.currentUserId,
      chatId,
      files: files.length > 0 ? files : undefined,
      timeoutMs: args.timeoutMs,
      networkAccess: args.networkAccess,
    });

    return serializeCseResult(chatId, result);
  };

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
    execute: async (args: { code: string; language?: ExecutionLanguage; chatId?: string; timeoutMs?: number; networkAccess?: boolean }) => runInSandbox(args),
    tags: ['sandbox', 'compute', 'code'],
    riskLevel: 'external-side-effect',
  });

  const dataAnalysisImage = process.env['CSE_DATA_ANALYSIS_IMAGE'] ?? 'weaveintel/cse-data-analysis:local';
  const runDataAnalysis = weaveTool({
    name: 'cse_run_data_analysis',
    description: 'Run Python data-analysis and charting code in a preloaded sandbox with pandas, numpy, matplotlib, seaborn, plotly, pyarrow, openpyxl, scikit-learn, and statsmodels already installed.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python analysis code to execute in the data-analysis sandbox.' },
        language: { type: 'string', enum: ['python'], description: 'Execution language. Only python is supported in the data-analysis sandbox.' },
        chatId: { type: 'string', description: 'Optional chat ID. Defaults to current chat context.' },
        timeoutMs: { type: 'number', description: 'Optional execution timeout in milliseconds.' },
        networkAccess: { type: 'boolean', description: 'Allow outbound network access for this run.' },
      },
      required: ['code'],
    },
    execute: async (args: { code: string; language?: 'python'; chatId?: string; timeoutMs?: number; networkAccess?: boolean }) => runInSandbox({ ...args, language: 'python' }, dataAnalysisImage),
    tags: ['sandbox', 'compute', 'analysis', 'charting'],
    riskLevel: 'external-side-effect',
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
    cse_run_data_analysis: runDataAnalysis,
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
  social_insights_read: socialInsightsReadTool,
  social_comments_read: socialCommentsReadTool,
  social_post: socialPostTool,
  workflow_run: workflowRunTool,
  ...browserToolMap(),
  ...cseToolMap(),
  ...statsNzToolMap(),
  ...createSVToolMap(),
  ...createKaggleToolMap(),
};

/**
 * Sync BUILTIN_TOOLS into the tool_catalog table so operators can manage them
 * via the admin panel. Called once at startup via startGeneWeave / index.ts.
 * Uses upsert-by-tool_key so re-runs are safe and idempotent.
 */
export async function syncToolCatalog(db: DatabaseAdapter): Promise<void> {
  for (const [key, tool] of Object.entries(BUILTIN_TOOLS)) {
    const existing = await db.getToolCatalogByKey(key);
    const riskLevel = tool.schema.riskLevel ?? 'read-only';
    const hasSideEffects = riskLevel !== 'read-only' ? 1 : 0;
    const allocationClass = inferAllocationClass(key, tool.schema.tags);
    if (!existing) {
      await db.createToolConfig({
        id: newUUIDv7(),
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
        allocation_class: allocationClass,
        requires: tool.schema.requires && tool.schema.requires.length > 0
          ? JSON.stringify(tool.schema.requires)
          : null,
      });
    } else {
      // Upsert risk_level, side_effects, name, and description so code-side changes propagate.
      // Only set allocation_class on upsert if currently null (do not stomp operator overrides).
      const upsertFields: Record<string, unknown> = {
        risk_level: riskLevel,
        side_effects: hasSideEffects,
        name: tool.schema.name,
        description: tool.schema.description,
        requires: tool.schema.requires && tool.schema.requires.length > 0
          ? JSON.stringify(tool.schema.requires)
          : null,
      };
      if (!existing.allocation_class && allocationClass) {
        upsertFields['allocation_class'] = allocationClass;
      }
      await db.updateToolConfig(existing.id, upsertFields);
    }
  }
}

/**
 * Infer a default allocation_class for a builtin tool based on its key prefix and tags.
 * Operators can override this in the admin panel.
 */
export function inferAllocationClass(key: string, tags: readonly string[] | undefined): string | null {
  const k = key.toLowerCase();
  const tagSet = new Set((tags ?? []).map((t) => t.toLowerCase()));
  if (k === 'datetime' || k === 'math_eval' || k === 'unit_convert' || k === 'calculator') return 'utility';
  if (k.startsWith('social_') || tagSet.has('social')) return 'social';
  if (k.startsWith('cse_') || tagSet.has('cse')) return 'cse';
  if (k === 'web_search' || tagSet.has('web-search') || tagSet.has('search')) return 'search';
  if (k.startsWith('http_') || tagSet.has('http')) return 'http';
  if (k.startsWith('enterprise_') || tagSet.has('enterprise')) return 'enterprise';
  if (k === 'code_executor' || k === 'sandbox' || tagSet.has('code')) return 'code';
  if (k.startsWith('browser_') || tagSet.has('browser') || tagSet.has('web')) return 'web';
  if (tagSet.has('communication') || tagSet.has('email') || tagSet.has('messaging')) return 'communication';
  if (tagSet.has('data') || tagSet.has('database') || tagSet.has('analytics')) return 'data';
  return null;
}

export interface ToolRegistryOptions {
  defaultTimezone?: string;
  temporalStore?: TemporalStore;
  currentUserId?: string;
  /** Tenant of the current user (weaveNotes Phase 3.1) — stamped on notes the agent creates. */
  currentTenantId?: string | null;
  currentChatId?: string;
  /** Run id (set on the /api/me/runs path) so emitted artifacts are run-scoped. */
  currentRunId?: string;
  currentAttachments?: RuntimeAttachment[];
  actorPersona?: string;
  memoryRecall?: (args: { userId: string; query: string; limit?: number }) => Promise<{
    semantic: Array<{ content: string; source: string }>;
    entities: Array<{ entityType: string; entityName: string; facts: Record<string, unknown> }>;
  }>;
  memorySearch?: (args: { userId: string; query: string; limit?: number }) => Promise<{
    semantic: Array<{ content: string; source: string; memoryType: string }>;
    entities: Array<{ entityType: string; entityName: string; facts: Record<string, unknown> }>;
  }>;
  memoryRemember?: (args: { userId: string; content: string; memoryType?: string; source?: string }) => Promise<{ id: string }>;
  memoryForget?: (args: { userId: string; entityName: string }) => Promise<{ ok: boolean; deletedEntities?: number; deletedSemantic?: number }>;
  memoryListEntities?: (args: { userId: string }) => Promise<{
    entities: Array<{ entityType: string; entityName: string; facts: Record<string, unknown>; confidence: number }>;
  }>;
  memoryListEpisodes?: (args: { userId: string; limit?: number }) => Promise<{
    episodes: Array<{ id: string; messageRole: string; content: string; importance: number; createdAt: string }>;
  }>;
  memoryGetProfile?: (args: { userId: string }) => Promise<{
    entities: Array<{ entityType: string; entityName: string; facts: Record<string, unknown>; confidence: number }>;
    semantic: Array<{ content: string; memoryType: string; source: string }>;
    episodic: Array<{ messageRole: string; content: string; createdAt: string }>;
    procedural: Array<{ instructionDelta: string; appliedAt: string }>;
  }>;
  /** Save a JSON state blob to the working-memory store (agent scratch state). */
  memorySaveSnapshot?: (args: { userId: string; chatId?: string; agentId?: string; state: Record<string, unknown> }) => Promise<{ id: string }>;
  /** Load the latest working-memory snapshot for the current session. */
  memoryLoadSnapshot?: (args: { userId: string; agentId?: string }) => Promise<{ snapshot: Record<string, unknown> | null; id: string | null; savedAt: string | null }>;
  /** Propose a procedural instruction delta for human review and approval. */
  memoryProposeInstruction?: (args: { userId: string; agentId: string; instruction: string; reason?: string; confidence?: number }) => Promise<{ id: string }>;
  /** List the user's agenda items (calendar events, deadlines, reminders). */
  agendaList?: (args: { userId: string; startAt?: string; endAt?: string; kind?: string; limit?: number; search?: string }) => Promise<Array<{ id: string; title: string; kind: string; status: string; start_at: string | null; end_at: string | null; all_day: number; location: string | null; description: string | null; created_at: string }>>;
  /** Find agenda items with similar titles within a date window for duplicate detection. */
  agendaFindSimilar?: (args: { userId: string; title: string; dateBucket?: string }) => Promise<Array<{ id: string; title: string; kind: string; start_at: string | null }>>;
  /** Create a new agenda item for the user. */
  agendaCreate?: (args: { userId: string; title: string; kind?: string; startAt?: string; endAt?: string; allDay?: boolean; location?: string; description?: string }) => Promise<{ id: string; title: string; kind: string; start_at: string | null }>;
  /** Update an existing agenda item. Only provided fields are changed. */
  agendaUpdate?: (args: { userId: string; id: string; title?: string; kind?: string; startAt?: string; endAt?: string; allDay?: boolean; location?: string; description?: string; status?: string }) => Promise<{ id: string; title: string; start_at: string | null } | null>;
  /** Delete an agenda item by ID. Returns true if deleted, false if not found. */
  agendaDelete?: (args: { userId: string; id: string }) => Promise<{ deleted: boolean }>;
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
  skillPolicyKey?: string;
  /**
   * Tools explicitly enabled at the chat level (settings.enabledTools). Passed
   * into the policy resolution context so that skill policies cannot block tools
   * the operator intentionally granted access to.
   */
  explicitEnabledTools?: string[];
  /**
   * Phase D — the host's `weaveRuntime` instance. When supplied,
   * `weaveToolRegistry({ runtime })` asserts every tool's
   * `schema.requires` against the runtime's advertised capabilities at
   * `register()` time, so misconfigurations surface at boot rather than
   * on first invocation. Optional for back-compat; without it the
   * registry falls back to invocation-time `runtime.require(...)` checks.
   */
  runtime?: WeaveRuntime;
  /**
   * P4-3 — Caller-supplied knowledge graph store for graph memory tools.
   * When set, the four graph_* tools are available for registration.
   * Use createGraphMemoryStore() (in-memory) or a SQLite-backed adapter.
   */
  graphStore?: GraphMemoryStore;
  /**
   * Scope isolation guard — wraps every tool execution with a cross-scope
   * policy check. Set in ChatEngine.toolOptions; callerScope is overridden
   * per-worker in buildWorkersFromDb() to the worker's agentic_scope value.
   */
  scopeGuard?: import('./scope-guard-registry.js').ScopeGuardCallbacks;
  /**
   * Cache Phase 6 — opt-in tool-result caching. When set, each tool's result is
   * cached per the DB-driven `tool_cache_policies` (per-tool TTL). Applied as the
   * INNERMOST registry wrapper so authorization/scope/rate-limit checks still run
   * on every call; only the underlying `invoke()` is skipped on a cache hit.
   */
  toolResultCache?: import('./tool-cache-registry.js').ToolResultCacheCallbacks;
  /**
   * Artifact persistence callback. When set, the `emit_artifact` built-in tool
   * is available to all agents. Called with the artifact payload; returns the
   * saved row's id and version.
   */
  artifactSave?: (input: import('./db-types/artifacts.js').ArtifactSaveInput) => Promise<{ id: string; version: number }>;
  /**
   * m79 / Phase 4: Artifact update callback for streaming mode.
   * When set alongside `artifactSave`, `emit_artifact` can operate in
   * streaming mode — saving an initial row, emitting SSE progress events,
   * then writing the final data once complete.
   */
  artifactUpdate?: (id: string, patch: import('./db-types/artifacts.js').ArtifactUpdateInput, changelog?: string) => Promise<{ id: string; version: number }>;
  /**
   * m78: Pre-resolved effective tenant artifact settings for the current session.
   * When set, the `emit_artifact` tool enforces emit_enabled, allowed_types, and
   * max_size_bytes before persisting. Resolved from tenant_artifact_settings by
   * getEffectiveTenantArtifactSettings() (falls back to "default" row).
   */
  resolvedArtifactSettings?: {
    allowed_types: string[] | null;
    max_size_bytes: number | null;
    emit_enabled: boolean;
    preview_enabled: boolean;
    sandbox_html: boolean;
  };
  /**
   * weaveNotes Phase 3: note co-author callback. When set, the `note_edit` built-in
   * tool is available so the agent can write into one of the user's notes — either
   * `direct` (applied as a co-editing peer, converging live) or `suggest` (staged as
   * a track-changes suggestion a human accepts/rejects). The callback resolves the
   * user's access to the note itself, so the agent can never edit a note the user
   * cannot, and viewers are refused.
   */
  noteEdit?: (args: { userId: string; noteId: string; markdown: string; mode: 'direct' | 'suggest' }) => Promise<{ ok: boolean; error?: string; applied?: number; suggestionId?: string }>;
  /**
   * weaveNotes Phase 4: note publish callback. When set, the `note_publish` built-in
   * tool is available so the agent can turn one of the user's notes into a shareable
   * artifact (Markdown/HTML). The callback resolves the user's note access + enforces
   * the sensitivity gate (a `restricted` note is refused; secrets/PII are redacted), and
   * — for safety — the agent creates the artifact PRIVATELY (it never auto-mints a public
   * link; a human opts into public sharing).
   */
  notePublish?: (args: { userId: string; noteId: string; format?: 'markdown' | 'html' }) => Promise<{ ok: boolean; error?: string; artifactId?: string; redactions?: number; sourceSensitivity?: string }>;
  /**
   * weaveNotes Phase 3.1: note creation callback. When set, the `create_note` built-in
   * tool is available so the agent can create a brand-new note for the user and seed it
   * with Markdown content it produced (research, a summary, a plan, to-dos). Returns the
   * new note id, which the agent can pass to `note_edit` / `note_publish`.
   */
  createNote?: (args: { userId: string; tenantId?: string | null; title: string; markdown?: string }) => Promise<{ ok: boolean; error?: string; noteId?: string }>;
  /**
   * weaveNotes Phase 5: semantic note search. When set, the `find_related_notes` tool is
   * available so the agent can find the user's notes most relevant to a query (knowledge-
   * graph navigation) before answering, editing, or linking. Owner-scoped.
   */
  notesSearch?: (args: { userId: string; tenantId?: string | null; query: string; limit?: number }) => Promise<Array<{ noteId: string; title: string; score: number }>>;
  /**
   * weaveNotes Phase 6: database column auto-fill. When set, the `autofill_database` tool is
   * available so the agent can fill a column of one of the user's note databases from each
   * row's context (the page + workspace + optionally the web), with citations. Owner-scoped.
   */
  dbAutofill?: (args: { userId: string; tenantId?: string | null; databaseId: string; propertyKey: string; useWeb?: boolean }) => Promise<{ ok: boolean; error?: string; filled?: number }>;
}

export function filterToolNamesByPersona(toolNames: string[], persona: string | null | undefined): string[] {
  return toolNames.filter((toolName) => canUseTool(persona, toolName));
}

// ─── Phase 4+: MCP Streamable HTTP transport factory ───────────
// Uses the official MCP SDK Streamable HTTP client transport in stateless-
// compatible mode. Auth headers are resolved lazily per request.
function createHttpMCPTransport(
  endpoint: string,
  credentialResolver?: (id: string) => Promise<import('./db-types.js').ToolCredentialRow | null>,
  credentialId?: string,
): import('@weaveintel/core').MCPTransport {
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

  return createMCPStreamableHttpTransport(endpoint, {
    getHeaders: resolveAuthHeader,
    requestInit: {
      headers: {
        'Content-Type': 'application/json',
      },
    },
  });
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
      const result = await client.sendMessage(
        { executionId: newUUIDv7(), metadata: args.context ?? {} },
        agentUrl,
        {
          message: {
            role: 'user',
            parts: [{ text: args.task }],
            messageId: newUUIDv7(),
          },
          metadata: args.context,
        },
      );
      if (result.status.state === 'TASK_STATE_FAILED') {
        const errText = result.status.message?.parts[0]?.text ?? 'Unknown error';
        return { content: `A2A error: ${errText}`, isError: true };
      }
      const outputText = (result.artifacts[0]?.parts ?? [])
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .join('\n');
      return outputText || JSON.stringify(result);
    },
    tags: ['a2a', 'external'],
  });
}

/**
 * Create a ToolRegistry pre-loaded with the selected built-in tools
 * plus any custom tools provided.
 */
export async function createToolRegistry(toolNames: string[], customTools?: Tool[], opts?: ToolRegistryOptions): Promise<ToolRegistry> {
  const registry = weaveToolRegistry(opts?.runtime ? { runtime: opts.runtime } : undefined);
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

  const memorySearchTool = weaveTool({
    name: 'memory_search',
    description: 'Perform a targeted search of the user\'s long-term memory using natural language. Returns ranked semantic memories and matching entity facts.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for in memory' },
        limit: { type: 'number', description: 'Max results to return (default: 5, max: 20)' },
      },
      required: ['query'],
    },
    execute: async (args: { query: string; limit?: number }) => {
      if (!opts?.memorySearch || !opts.currentUserId) {
        return { content: 'Memory search is unavailable in this execution context.', isError: true };
      }
      const limit = Math.max(1, Math.min(20, Number(args.limit ?? 5)));
      const results = await opts.memorySearch({ userId: opts.currentUserId, query: args.query, limit });
      return JSON.stringify({
        query: args.query,
        semanticCount: results.semantic.length,
        entityCount: results.entities.length,
        semantic: results.semantic,
        entities: results.entities,
      }, null, 2);
    },
    tags: ['memory', 'search'],
  });

  const memoryRememberTool = weaveTool({
    name: 'memory_remember',
    description: 'Explicitly save a fact or note to the user\'s long-term memory. Use when the user asks you to remember something specific.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact or note to remember' },
        memoryType: {
          type: 'string',
          description: 'Category: user_fact, preference, or summary (default: user_fact)',
          enum: ['user_fact', 'preference', 'summary'],
        },
      },
      required: ['content'],
    },
    execute: async (args: { content: string; memoryType?: string }) => {
      if (!opts?.memoryRemember || !opts.currentUserId) {
        return { content: 'Memory remember is unavailable in this execution context.', isError: true };
      }
      const result = await opts.memoryRemember({
        userId: opts.currentUserId,
        content: args.content,
        memoryType: args.memoryType ?? 'user_fact',
        source: 'user_requested',
      });
      return JSON.stringify({ ok: true, id: result.id });
    },
    tags: ['memory', 'remember'],
  });

  const memoryForgetTool = weaveTool({
    name: 'memory_forget',
    description: 'Remove memories about a subject from the user\'s long-term memory. Removes the named entity from entity memory AND any semantic memory entry whose stored text contains the given string (case-insensitive substring match). Only use when the user explicitly asks you to forget something.',
    parameters: {
      type: 'object',
      properties: {
        entityName: { type: 'string', description: 'The entity name, subject, or short content snippet identifying memories to forget' },
      },
      required: ['entityName'],
    },
    execute: async (args: { entityName: string }) => {
      if (!opts?.memoryForget || !opts.currentUserId) {
        return { content: 'Memory forget is unavailable in this execution context.', isError: true };
      }
      const result = await opts.memoryForget({ userId: opts.currentUserId, entityName: args.entityName });
      return JSON.stringify({
        ok: result.ok,
        entityName: args.entityName,
        deletedEntities: result.deletedEntities ?? 0,
        deletedSemantic: result.deletedSemantic ?? 0,
      });
    },
    tags: ['memory', 'forget'],
  });

  const memoryListEntitiesTool = weaveTool({
    name: 'memory_list_entities',
    description: 'List all known facts about the current user from the entity memory store — name, location, job, preferences, and other extracted attributes.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async () => {
      if (!opts?.memoryListEntities || !opts.currentUserId) {
        return { content: 'Memory list entities is unavailable in this execution context.', isError: true };
      }
      const result = await opts.memoryListEntities({ userId: opts.currentUserId });
      return JSON.stringify({ entityCount: result.entities.length, entities: result.entities }, null, 2);
    },
    tags: ['memory', 'profile'],
  });

  const memoryListEpisodesTool = weaveTool({
    name: 'memory_list_episodes',
    description: 'List the most recent episodic memory events for the current user — a timestamped log of what was said in past conversation turns. Useful for recalling context from previous sessions.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max events to return (default: 10, max: 30)' },
      },
      required: [],
    },
    execute: async (args: { limit?: number }) => {
      if (!opts?.memoryListEpisodes || !opts.currentUserId) {
        return { content: 'Episodic memory is unavailable in this execution context.', isError: true };
      }
      const limit = Math.max(1, Math.min(30, Number(args.limit ?? 10)));
      const result = await opts.memoryListEpisodes({ userId: opts.currentUserId, limit });
      return JSON.stringify({ episodeCount: result.episodes.length, episodes: result.episodes }, null, 2);
    },
    tags: ['memory', 'episodic', 'history'],
  });

  const memoryGetProfileTool = weaveTool({
    name: 'memory_get_profile',
    description: 'Return a comprehensive profile of the current user assembled from all memory stores — entity facts, semantic memories, recent episodes, and applied procedural instructions. Use this to build a full picture of who the user is before personalising a response.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async () => {
      if (!opts?.memoryGetProfile || !opts.currentUserId) {
        return { content: 'User profile memory is unavailable in this execution context.', isError: true };
      }
      const profile = await opts.memoryGetProfile({ userId: opts.currentUserId });
      return JSON.stringify(profile, null, 2);
    },
    tags: ['memory', 'profile', 'identity'],
  });

  const memorySnapshotTool = weaveTool({
    name: 'memory_snapshot',
    description: 'Save the current working state as a JSON snapshot to working memory. Use this to checkpoint progress during multi-step tasks so it can be resumed if the conversation continues later. Only call this when you have meaningful intermediate state worth preserving.',
    parameters: {
      type: 'object',
      properties: {
        state: {
          type: 'object',
          description: 'Arbitrary JSON object representing the current working state (task progress, intermediate results, next steps, etc.)',
        },
        label: {
          type: 'string',
          description: 'Optional human-readable label for this snapshot (e.g. "after step 2 of 5")',
        },
      },
      required: ['state'],
    },
    execute: async (args: { state: Record<string, unknown>; label?: string }) => {
      if (!opts?.memorySaveSnapshot || !opts.currentUserId) {
        return { content: 'Working memory is unavailable in this execution context.', isError: true };
      }
      const stateWithLabel = args.label ? { ...args.state, _label: args.label } : args.state;
      const result = await opts.memorySaveSnapshot({
        userId: opts.currentUserId,
        chatId: opts.currentChatId,
        state: stateWithLabel,
      });
      return JSON.stringify({ ok: true, snapshotId: result.id, label: args.label ?? null });
    },
    tags: ['memory', 'working', 'state'],
  });

  const memoryLoadStateTool = weaveTool({
    name: 'memory_load_state',
    description: 'Load the most recent working memory snapshot for this user. Use this at the start of a resumed multi-step task to restore the agent\'s previous intermediate state rather than starting from scratch.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async () => {
      if (!opts?.memoryLoadSnapshot || !opts.currentUserId) {
        return { content: 'Working memory is unavailable in this execution context.', isError: true };
      }
      const result = await opts.memoryLoadSnapshot({ userId: opts.currentUserId });
      if (!result.snapshot) {
        return JSON.stringify({ found: false, snapshot: null });
      }
      return JSON.stringify({ found: true, snapshotId: result.id, savedAt: result.savedAt, snapshot: result.snapshot });
    },
    tags: ['memory', 'working', 'state'],
  });

  const memoryProposeInstructionTool = weaveTool({
    name: 'memory_propose_instruction',
    description: 'Propose a persistent behavioural adjustment for how the agent should interact with this user in future conversations. The proposal is submitted for human review and must be approved before it takes effect. Only use this when you have strong evidence that a change would improve the user\'s experience — for example, the user has expressed a consistent preference that should always be applied.',
    parameters: {
      type: 'object',
      properties: {
        instruction: {
          type: 'string',
          description: 'The behavioural change to propose (e.g. "Always respond with bullet points instead of paragraphs for this user")',
        },
        reason: {
          type: 'string',
          description: 'Brief justification — what evidence led to this proposal',
        },
        confidence: {
          type: 'number',
          description: 'Confidence in this proposal (0.0–1.0, default 0.75)',
        },
      },
      required: ['instruction'],
    },
    execute: async (args: { instruction: string; reason?: string; confidence?: number }) => {
      if (!opts?.memoryProposeInstruction || !opts.currentUserId) {
        return { content: 'Procedural memory proposals are unavailable in this execution context.', isError: true };
      }
      const result = await opts.memoryProposeInstruction({
        userId: opts.currentUserId,
        agentId: 'default',
        instruction: args.instruction,
        reason: args.reason,
        confidence: args.confidence ?? 0.75,
      });
      return JSON.stringify({ ok: true, proposalId: result.id, status: 'proposed', message: 'Proposal submitted for human review. It will take effect only after an admin approves and applies it.' });
    },
    tags: ['memory', 'procedural', 'proposal'],
  });

  const agendaListTool = weaveTool({
    name: 'agenda_list',
    description: "Retrieve the user's calendar events, appointments, deadlines, and reminders from the database. ALWAYS call this tool before answering any calendar question — you have no inherent knowledge of the user's events. Use 'search' to filter by keyword (e.g. 'dentist'), 'kind' to filter by type, and date params to bound the window. Default limit is 10; always set start_at to scope the query.",
    parameters: {
      type: 'object',
      properties: {
        start_at: { type: 'string', description: "ISO date lower bound (e.g. '2026-06-15'). Use today's date for future-focused queries. Defaults to today if omitted." },
        end_at: { type: 'string', description: "ISO date upper bound (e.g. '2026-06-21'). Required for bounded queries like 'this week' or 'free on Friday'." },
        kind: {
          type: 'string',
          description: "Filter by item type.",
          enum: ['event', 'deadline', 'reminder', 'appointment', 'recurring', 'follow-up'],
        },
        search: { type: 'string', description: "Case-insensitive keyword filter on event title. Use for 'when is my X' queries (e.g. search='dentist')." },
        limit: { type: 'number', description: 'Max items to return (default 10, max 50). Increase only for wide date ranges or explicit "show all" requests.' },
      },
      required: [],
    },
    execute: async (args: { start_at?: string; end_at?: string; kind?: string; search?: string; limit?: number }) => {
      if (!opts?.agendaList || !opts.currentUserId) {
        return { content: 'Calendar data is unavailable in this execution context.', isError: true };
      }
      const today = new Date().toISOString().slice(0, 10);
      const startAt = args.start_at ?? today;
      const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10)));
      const items = await opts.agendaList({
        userId: opts.currentUserId,
        startAt,
        endAt: args.end_at,
        kind: args.kind,
        search: args.search,
        limit,
      });
      if (!items.length) {
        return JSON.stringify({ count: 0, items: [], message: 'No agenda items found for the given filter.' });
      }
      return JSON.stringify({ count: items.length, items }, null, 2);
    },
    tags: ['calendar', 'agenda', 'personal'],
    riskLevel: 'read-only',
  });

  const agendaCreateTool = weaveTool({
    name: 'agenda_create',
    description: "Create a new calendar event, appointment, deadline, or reminder. IMPORTANT: This tool automatically checks for near-duplicate events on the same date before creating. If a similar event already exists, it returns a 'duplicate' response instead of creating — inform the user and ask if they want to update the existing one instead.",
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title or name of the event (required).' },
        kind: { type: 'string', enum: ['event', 'appointment', 'deadline', 'reminder', 'recurring', 'follow-up'], description: "Type of item. Use 'appointment' for doctor/dentist/meetings, 'deadline' for due dates, 'reminder' for nudges, 'event' for general." },
        start_at: { type: 'string', description: "ISO datetime or date string (e.g. '2026-07-01T10:00' or '2026-07-01'). Required for timed items." },
        end_at: { type: 'string', description: 'ISO datetime for when the event ends (optional).' },
        all_day: { type: 'boolean', description: 'True for all-day events. Defaults to false if start_at includes a time.' },
        location: { type: 'string', description: 'Location or meeting link (optional).' },
        description: { type: 'string', description: 'Additional notes or description (optional).' },
      },
      required: ['title'],
    },
    execute: async (args: { title: string; kind?: string; start_at?: string; end_at?: string; all_day?: boolean; location?: string; description?: string }) => {
      if (!opts?.agendaCreate || !opts.currentUserId) {
        return JSON.stringify({ error: 'Calendar creation is unavailable in this context.' });
      }
      try {
        // Dedup check: find semantically similar events on the same date before inserting
        if (opts.agendaFindSimilar && args.start_at) {
          const dateBucket = args.start_at.slice(0, 10);
          const similar = await opts.agendaFindSimilar({
            userId: opts.currentUserId,
            title: args.title,
            dateBucket,
          });
          if (similar.length > 0) {
            return JSON.stringify({
              duplicate: true,
              message: `A similar event already exists on ${dateBucket}. Did you mean to update it instead?`,
              existing: similar.map(s => ({ id: s.id, title: s.title, kind: s.kind, start_at: s.start_at })),
            });
          }
        }
        const item = await opts.agendaCreate({
          userId: opts.currentUserId,
          title: args.title,
          kind: args.kind,
          startAt: args.start_at,
          endAt: args.end_at,
          allDay: args.all_day,
          location: args.location,
          description: args.description,
        });
        return JSON.stringify({ ok: true, id: item.id, title: item.title, kind: item.kind, start_at: item.start_at, message: 'Calendar item created.' });
      } catch (e) {
        return JSON.stringify({ error: String(e) });
      }
    },
    tags: ['calendar', 'agenda', 'personal'],
    riskLevel: 'write',
  });

  const agendaUpdateTool = weaveTool({
    name: 'agenda_update',
    description: "Update an existing calendar event or agenda item. Use this to reschedule, rename, change location, or update status. First use agenda_list to find the item ID, then call this tool. Only the fields you provide will be changed.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID of the agenda item to update (from agenda_list results).' },
        title: { type: 'string', description: 'New title (optional).' },
        kind: { type: 'string', enum: ['event', 'appointment', 'deadline', 'reminder', 'recurring', 'follow-up'], description: 'New kind (optional).' },
        start_at: { type: 'string', description: 'New start datetime in ISO format (optional).' },
        end_at: { type: 'string', description: 'New end datetime in ISO format (optional).' },
        all_day: { type: 'boolean', description: 'Set to true/false to change all-day status (optional).' },
        location: { type: 'string', description: 'New location (optional).' },
        description: { type: 'string', description: 'New description (optional).' },
        status: { type: 'string', enum: ['confirmed', 'tentative', 'cancelled'], description: "New status (optional). Use 'cancelled' to cancel without deleting." },
      },
      required: ['id'],
    },
    execute: async (args: { id: string; title?: string; kind?: string; start_at?: string; end_at?: string; all_day?: boolean; location?: string; description?: string; status?: string }) => {
      if (!opts?.agendaUpdate || !opts.currentUserId) {
        return JSON.stringify({ error: 'Calendar update is unavailable in this context.' });
      }
      try {
        const item = await opts.agendaUpdate({
          userId: opts.currentUserId,
          id: args.id,
          title: args.title,
          kind: args.kind,
          startAt: args.start_at,
          endAt: args.end_at,
          allDay: args.all_day,
          location: args.location,
          description: args.description,
          status: args.status,
        });
        if (!item) return JSON.stringify({ error: 'Item not found or not owned by user.' });
        return JSON.stringify({ ok: true, id: item.id, title: item.title, start_at: item.start_at, message: 'Calendar item updated.' });
      } catch (e) {
        return JSON.stringify({ error: String(e) });
      }
    },
    tags: ['calendar', 'agenda', 'personal'],
    riskLevel: 'write',
  });

  const agendaDeleteTool = weaveTool({
    name: 'agenda_delete',
    description: "Delete a calendar event or agenda item permanently. Use this when the user asks to 'remove', 'delete', or 'cancel and delete' an event. First use agenda_list to confirm the correct item ID. Prefer setting status='cancelled' via agenda_update for soft-cancel.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID of the agenda item to delete (from agenda_list results).' },
      },
      required: ['id'],
    },
    execute: async (args: { id: string }) => {
      if (!opts?.agendaDelete || !opts.currentUserId) {
        return JSON.stringify({ error: 'Calendar deletion is unavailable in this context.' });
      }
      try {
        const result = await opts.agendaDelete({ userId: opts.currentUserId, id: args.id });
        return result.deleted
          ? JSON.stringify({ ok: true, message: 'Calendar item deleted.' })
          : JSON.stringify({ error: 'Item not found or not owned by user.' });
      } catch (e) {
        return JSON.stringify({ error: String(e) });
      }
    },
    tags: ['calendar', 'agenda', 'personal'],
    riskLevel: 'destructive',
  });

  const scopedTools: Record<string, Tool> = {
    ...BUILTIN_TOOLS,
    ...createTimeToolMap(opts?.defaultTimezone, opts?.temporalStore ?? defaultTemporalStore),
    ...cseToolMap(opts),
    memory_recall: memoryRecallTool,
    memory_search: memorySearchTool,
    memory_remember: memoryRememberTool,
    memory_forget: memoryForgetTool,
    memory_list_entities: memoryListEntitiesTool,
    memory_list_episodes: memoryListEpisodesTool,
    memory_get_profile: memoryGetProfileTool,
    memory_snapshot: memorySnapshotTool,
    memory_load_state: memoryLoadStateTool,
    memory_propose_instruction: memoryProposeInstructionTool,
    agenda_list: agendaListTool,
    agenda_create: agendaCreateTool,
    agenda_update: agendaUpdateTool,
    agenda_delete: agendaDeleteTool,
    // P4-3: Knowledge graph tools — only available when graphStore is provided
    ...(opts?.graphStore ? Object.fromEntries(createGraphMemoryToolSet(opts.graphStore).map((t: Tool) => [t.schema.name, t])) : {}),
    // weaveNotes Phase 3: note co-author tool — available when noteEdit callback is set.
    ...(opts?.noteEdit && opts.currentUserId ? {
      note_edit: weaveTool({
        name: 'note_edit',
        description: 'Write content into one of the user\'s notes (the AI as a co-author). Provide Markdown. mode="suggest" (default) stages it as a track-changes suggestion the user accepts or reject; mode="direct" applies it immediately as a co-editing peer (use only when the user explicitly asked the AI to edit the note). The note must be one the user owns or can edit; you only need its id.',
        parameters: {
          type: 'object',
          properties: {
            noteId: { type: 'string', description: 'The id of the note to edit (the user must own it or be a collaborator).' },
            markdown: { type: 'string', description: 'The content to add, as Markdown (headings, lists, to-dos, etc.).' },
            mode: { type: 'string', enum: ['suggest', 'direct'], description: 'suggest = stage for human review (default); direct = apply immediately.' },
          },
          required: ['noteId', 'markdown'],
        },
        execute: async (args: { noteId: string; markdown: string; mode?: 'direct' | 'suggest' }) => {
          if (!opts.noteEdit || !opts.currentUserId) return { content: 'Note editing is unavailable in this context.', isError: true };
          const r = await opts.noteEdit({ userId: opts.currentUserId, noteId: args.noteId, markdown: args.markdown, mode: args.mode === 'direct' ? 'direct' : 'suggest' });
          if (!r.ok) return { content: `note_edit failed: ${r.error ?? 'unknown error'}`, isError: true };
          return JSON.stringify({ ok: true, mode: args.mode === 'direct' ? 'direct' : 'suggest', applied: r.applied ?? 0, suggestionId: r.suggestionId ?? null });
        },
        tags: ['notes', 'output'],
      }),
    } : {}),
    // weaveNotes Phase 6: database column auto-fill — available when dbAutofill callback is set.
    ...(opts?.dbAutofill && opts.currentUserId ? {
      autofill_database: weaveTool({
        name: 'autofill_database',
        description: 'Fill in a column of one of the user\'s note databases (tables) using AI — e.g. a Summary, Category, Priority, or a looked-up fact for every row. Each filled cell records citations. Set useWeb=true to let it search the web for facts it cannot find in the existing data. You need the database id and the column\'s property key.',
        parameters: {
          type: 'object',
          properties: {
            databaseId: { type: 'string', description: 'The id of the note database (table) to fill.' },
            propertyKey: { type: 'string', description: 'The key of the column (property) to fill.' },
            useWeb: { type: 'boolean', description: 'Allow a web search for facts not present in the rows (default false).' },
          },
          required: ['databaseId', 'propertyKey'],
        },
        execute: async (args: { databaseId: string; propertyKey: string; useWeb?: boolean }) => {
          if (!opts.dbAutofill || !opts.currentUserId) return { content: 'Database auto-fill is unavailable in this context.', isError: true };
          const r = await opts.dbAutofill({ userId: opts.currentUserId, tenantId: opts.currentTenantId ?? null, databaseId: args.databaseId, propertyKey: args.propertyKey, useWeb: args.useWeb === true });
          if (!r.ok) return { content: `autofill_database failed: ${r.error ?? 'unknown error'}`, isError: true };
          return JSON.stringify({ ok: true, filled: r.filled ?? 0 });
        },
        tags: ['notes', 'database', 'output'],
      }),
    } : {}),
    // weaveNotes Phase 5: semantic note search — available when notesSearch callback is set.
    ...(opts?.notesSearch && opts.currentUserId ? {
      find_related_notes: weaveTool({
        name: 'find_related_notes',
        description: 'Search the user\'s notes for the ones most relevant to a query (semantic similarity over their knowledge base). Use this before answering questions about "my notes", to find a note to edit/link/publish, or to discover related material. Returns matching notes with id + title + a relevance score.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to look for across the user\'s notes.' },
            limit: { type: 'number', description: 'Max results (default 5, max 20).' },
          },
          required: ['query'],
        },
        execute: async (args: { query: string; limit?: number }) => {
          if (!opts.notesSearch || !opts.currentUserId) return { content: 'Note search is unavailable in this context.', isError: true };
          const limit = Math.max(1, Math.min(20, Number(args.limit ?? 5)));
          const results = await opts.notesSearch({ userId: opts.currentUserId, tenantId: opts.currentTenantId ?? null, query: args.query, limit });
          return JSON.stringify({ query: args.query, count: results.length, notes: results });
        },
        tags: ['notes', 'memory'],
      }),
    } : {}),
    // weaveNotes Phase 3.1: create-note tool — available when createNote callback is set.
    ...(opts?.createNote && opts.currentUserId ? {
      create_note: weaveTool({
        name: 'create_note',
        description: 'Create a brand-new note for the user and fill it with content you provide as Markdown. Use this when the user asks to "create/make/start a note", "save this as a note", or "write up … as a note". Put the actual content (headings, bullet points, to-dos as "- [ ] task", code blocks, etc.) in `markdown`, based on what the user asked about or the information discussed. Returns the new note id (which you can then pass to note_edit to add more, or note_publish to share).',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'A short, descriptive title for the note.' },
            markdown: { type: 'string', description: 'The note body as Markdown — the research/summary/plan the user asked for. Supports headings, bullet/numbered lists, to-dos ("- [ ] task"), code blocks, quotes, bold/italic/links.' },
          },
          required: ['title'],
        },
        execute: async (args: { title: string; markdown?: string }) => {
          if (!opts.createNote || !opts.currentUserId) return { content: 'Note creation is unavailable in this context.', isError: true };
          const r = await opts.createNote({ userId: opts.currentUserId, tenantId: opts.currentTenantId ?? null, title: args.title, ...(args.markdown ? { markdown: args.markdown } : {}) });
          if (!r.ok) return { content: `create_note failed: ${r.error ?? 'unknown error'}`, isError: true };
          return JSON.stringify({ ok: true, noteId: r.noteId, title: args.title });
        },
        tags: ['notes', 'output'],
      }),
    } : {}),
    // weaveNotes Phase 4: note publish tool — available when notePublish callback is set.
    ...(opts?.notePublish && opts.currentUserId ? {
      note_publish: weaveTool({
        name: 'note_publish',
        description: 'Publish one of the user\'s notes as a shareable artifact (a typed, versioned document). Use when the user asks to "publish", "export", or "turn this note into a document/report". You only need the note id. A "restricted" note is refused; secrets and (for confidential notes) personal data are redacted automatically. For safety the artifact is created privately — a human chooses whether to make a public link.',
        parameters: {
          type: 'object',
          properties: {
            noteId: { type: 'string', description: 'The id of the note to publish (the user must own it or be a collaborator).' },
            format: { type: 'string', enum: ['markdown', 'html'], description: 'Artifact format (default markdown).' },
          },
          required: ['noteId'],
        },
        execute: async (args: { noteId: string; format?: 'markdown' | 'html' }) => {
          if (!opts.notePublish || !opts.currentUserId) return { content: 'Note publishing is unavailable in this context.', isError: true };
          const r = await opts.notePublish({ userId: opts.currentUserId, noteId: args.noteId, ...(args.format ? { format: args.format } : {}) });
          if (!r.ok) return { content: `note_publish failed: ${r.error ?? 'unknown error'}`, isError: true };
          return JSON.stringify({ ok: true, artifactId: r.artifactId, format: args.format ?? 'markdown', redactions: r.redactions ?? 0, sensitivity: r.sourceSensitivity });
        },
        tags: ['notes', 'artifacts', 'output'],
      }),
    } : {}),
    // m77: Artifact emission tool — available when artifactSave callback is set
    ...(opts?.artifactSave ? {
      emit_artifact: weaveTool({
        name: 'emit_artifact',
        description: 'Save a named, typed, versioned artifact (report, chart, code file, CSV, etc.) from the current agent session. Returns the artifact ID and version for reference. Pass streaming:true for large artifacts to enable real-time SSE progress updates.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Human-readable artifact name (e.g. "Forecast Report Q3")' },
            type: {
              type: 'string',
              description: 'Artifact type',
              enum: ['text', 'markdown', 'csv', 'json', 'code', 'html', 'pdf', 'report', 'image', 'svg', 'diagram', 'mermaid', 'react', 'interactive', 'audio', 'video', 'spreadsheet', 'custom'],
            },
            data: { type: 'string', description: 'Artifact content (text, JSON-stringified object, or base64-encoded binary)' },
            language: { type: 'string', description: 'Language hint for code artifacts (e.g. "python", "typescript", "sql")' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering (e.g. ["forecast", "q3"])' },
            changelog: { type: 'string', description: 'What changed in this version (used for update operations)' },
            streaming: { type: 'boolean', description: 'Set true for large artifacts to stream progress via SSE while saving. The artifact ID is returned immediately; clients can subscribe to /api/artifacts/{id}/stream.' },
          },
          required: ['name', 'type', 'data'],
        },
        execute: async (args: { name: string; type: string; data: string; language?: string; tags?: string[]; changelog?: string; streaming?: boolean }) => {
          try {
            // m78: Tenant artifact settings enforcement
            const ts = opts.resolvedArtifactSettings;
            if (ts && !ts.emit_enabled) {
              return JSON.stringify({ ok: false, error: 'Artifact emission is disabled for this tenant.' });
            }
            if (ts?.allowed_types && !ts.allowed_types.includes(args.type)) {
              return JSON.stringify({ ok: false, error: `Artifact type "${args.type}" is not permitted by tenant policy. Allowed: ${ts.allowed_types.join(', ')}.` });
            }
            if (ts?.max_size_bytes && args.data.length > ts.max_size_bytes) {
              return JSON.stringify({ ok: false, error: `Artifact data (${args.data.length} bytes) exceeds tenant max size of ${ts.max_size_bytes} bytes.` });
            }

            const { inferMimeType } = await import('@weaveintel/artifacts');
            const mimeType = inferMimeType(
              args.type as import('@weaveintel/core').ArtifactType,
              args.language ? { language: args.language } : undefined,
            );
            const baseMeta = args.language
              ? { language: args.language, changelog: args.changelog }
              : { changelog: args.changelog };

            // m79 / Phase 4: Streaming mode — save initial row with streaming_status='streaming',
            // emit SSE progress events in chunks, then finalize with the complete data.
            if (args.streaming && opts.artifactUpdate) {
              const { emitArtifactStreamEvent } = await import('./lib/artifact-stream-bus.js');

              // Save initial row marked as streaming
              const initial = await opts.artifactSave!({
                name: args.name,
                type: args.type,
                mimeType,
                data: '',
                sessionId: opts.currentChatId,
                userId: opts.currentUserId,
                ...(opts.currentRunId ? { runId: opts.currentRunId } : {}),
                tags: args.tags,
                metadata: { ...baseMeta, streamingStatus: 'streaming', streamingProgress: 0 },
                scope: 'session',
                streamingStatus: 'streaming',
                streamingProgress: 0,
              });
              const artifactId = initial.id;

              // Simulate streaming: split data into ~3 chunks and emit progress events.
              // In production, the caller would feed actual LLM streaming chunks here.
              const chunkSize = Math.max(1, Math.ceil(args.data.length / 3));
              let accumulated = '';
              for (let i = 0; i < 3; i++) {
                const slice = args.data.slice(i * chunkSize, (i + 1) * chunkSize);
                if (!slice) break;
                accumulated += slice;
                const progress = Math.min(0.9, (i + 1) / 3);
                emitArtifactStreamEvent(artifactId, { kind: 'update', progress, data: accumulated });
                // Small async yield so SSE listeners can flush
                await new Promise<void>(r => setImmediate(r));
              }

              // Finalize: write complete data, clear streaming_status
              const updated = await opts.artifactUpdate(artifactId, {
                data: args.data,
                metadata: { ...baseMeta, streamingStatus: 'complete', streamingProgress: 1 },
                streamingStatus: null,
                streamingProgress: null,
              }, args.changelog);

              emitArtifactStreamEvent(artifactId, { kind: 'complete', progress: 1, version: updated.version });

              return JSON.stringify({
                ok: true, artifactId, version: updated.version,
                name: args.name, type: args.type, language: args.language ?? null,
                streaming: true, streamUrl: `/api/artifacts/${artifactId}/stream`,
              });
            }

            // Standard (non-streaming) save
            const saved = await opts.artifactSave!({
              name: args.name,
              type: args.type,
              mimeType,
              data: args.data,
              sessionId: opts.currentChatId,
              userId: opts.currentUserId,
              ...(opts.currentRunId ? { runId: opts.currentRunId } : {}),
              tags: args.tags,
              metadata: baseMeta,
              scope: 'session',
            });
            return JSON.stringify({ ok: true, artifactId: saved.id, version: saved.version, name: args.name, type: args.type, language: args.language ?? null });
          } catch (e) {
            return JSON.stringify({ ok: false, error: String(e) });
          }
        },
        tags: ['artifacts', 'output'],
      }),
    } : {}),
    // F2: Generative-UI widget emission. The model calls this to render a typed
    // widget inline; the run bridge maps the result onto a `widget.update` event
    // (reusing the @weaveintel/ui-primitives builders for the payload).
    emit_widget: weaveTool({
      name: 'emit_widget',
      description: 'Render a structured UI widget (table, chart, code block, etc.) inline. Use to present tabular data, a chart, or formatted code so the client renders an interactive component instead of plain text.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['table', 'chart', 'code', 'form', 'image', 'map', 'timeline', 'custom'], description: 'Widget kind' },
          title: { type: 'string', description: 'Optional widget title' },
          data: { type: 'object', description: 'Widget data. table: {columns:string[], rows:any[][]}; chart: {chartType:"bar"|"line"|"pie"|"scatter", labels:string[], datasets:[{label:string,data:number[]}]}; code: {code:string, language?:string}; other: any object.' },
        },
        required: ['type', 'data'],
      },
      execute: async (args: { type: string; title?: string; data?: Record<string, unknown> }) => {
        try {
          const uip = await import('@weaveintel/ui-primitives');
          const title = typeof args.title === 'string' ? args.title : '';
          const d = (args.data && typeof args.data === 'object') ? args.data : {};
          let widget: import('@weaveintel/core').WidgetPayload;
          if (args.type === 'table') {
            const columns = Array.isArray(d['columns']) ? (d['columns'] as unknown[]).map(String) : [];
            const rows = Array.isArray(d['rows']) ? (d['rows'] as unknown[][]) : [];
            widget = uip.tableWidget(title || 'Table', columns, rows);
          } else if (args.type === 'chart') {
            const chartType = (['bar', 'line', 'pie', 'scatter'] as const).find((c) => c === d['chartType']) ?? 'bar';
            const labels = Array.isArray(d['labels']) ? (d['labels'] as unknown[]).map(String) : [];
            const datasets = Array.isArray(d['datasets']) ? (d['datasets'] as Array<{ label: string; data: number[] }>) : [];
            widget = uip.chartWidget(title || 'Chart', chartType, labels, datasets);
          } else if (args.type === 'code') {
            widget = uip.codeWidget(title || 'Code', typeof d['code'] === 'string' ? d['code'] as string : '', typeof d['language'] === 'string' ? d['language'] as string : undefined);
          } else {
            widget = uip.createWidget({ type: args.type as import('@weaveintel/core').WidgetType, ...(title ? { title } : {}), data: d, interactive: false });
          }
          return JSON.stringify({ ok: true, widget });
        } catch (e) {
          return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      },
      tags: ['ui', 'output'],
    }),
  };
  const registeredFromSelection = new Set<string>();
  for (const name of filterToolNamesByPersona(toolNames, actorPersona)) {
    // Skip tools disabled in the operator-managed tool catalog
    if (opts?.disabledToolKeys && opts.disabledToolKeys.has(name)) continue;
    const tool = scopedTools[name];
    if (tool) { registry.register(tool); registeredFromSelection.add(name); }
  }
  // weaveNotes (Phase 3-4): the note-agent tools — create_note / note_edit / note_publish —
  // are CORE capabilities, each gated by per-call access checks (viewers/strangers refused).
  // Make them available whenever their callbacks are wired, REGARDLESS of the chat's saved
  // tool selection: mode policies only apply when `enabled_tools` is empty, so a user with a
  // custom tool selection would otherwise never get them (and "create a note" would silently
  // fall back to emit_artifact). Skip any already registered from the selection above.
  for (const noteTool of ['create_note', 'note_edit', 'note_publish', 'find_related_notes', 'autofill_database'] as const) {
    const t = scopedTools[noteTool];
    if (t && !registeredFromSelection.has(noteTool) && canUseTool(actorPersona, noteTool)) registry.register(t);
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
            const mcpToolDefs = await resolveMCPToolDefinitions(mcpClient);
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

  let finalRegistry: ToolRegistry = registry;

  // Cache Phase 6: tool-result caching is the INNERMOST wrapper (closest to the
  // real tool) so policy/scope/rate-limit checks below still run on every call;
  // only the underlying invoke() is skipped on a hit.
  if (opts?.toolResultCache) {
    const { wrapWithToolResultCache } = await import('./tool-cache-registry.js');
    finalRegistry = wrapWithToolResultCache(finalRegistry, opts.toolResultCache);
  }

  // Phase 2: wrap with policy enforcement when a resolver is provided.
  if (opts?.policyResolver) {
    finalRegistry = createPolicyEnforcedRegistry(finalRegistry, {
      resolver: opts.policyResolver,
      auditEmitter: opts.auditEmitter ?? noopAuditEmitter,
      rateLimiter: opts.rateLimiter,
      approvalGate: opts.approvalGate,
      resolutionContext: {
        agentPersona: opts.actorPersona,
        chatId: opts.currentChatId,
        userId: opts.currentUserId,
        skillPolicyKey: opts.skillPolicyKey,
        explicitEnabledTools: opts.explicitEnabledTools,
      },
      // Phase 3 of RESILIENCE_PLAN — every tool invocation flows through
      // the shared resilience pipeline so MCP/A2A/HTTP tool failures emit
      // normalized signals on the same bus the providers do. The DB
      // observer batches these into endpoint_health alongside LLM endpoints.
      resilience: { enabled: true, endpointPrefix: 'tool' },
    });
  }

  // Phase 4 (scope isolation): wrap with cross-scope access enforcement.
  if (opts?.scopeGuard) {
    const { wrapWithScopeGuard } = await import('./scope-guard-registry.js');
    finalRegistry = wrapWithScopeGuard(finalRegistry, opts.scopeGuard);
  }

  return finalRegistry;
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
