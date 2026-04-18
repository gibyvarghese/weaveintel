/**
 * @weaveintel/geneweave — Built-in tools & registry
 *
 * Ships a set of useful built-in tools that agents can use, plus
 * a helper to create a ToolRegistry from selected tool names.
 */

import type { Tool, ToolRegistry } from '@weaveintel/core';
import { weaveTool, weaveToolRegistry } from '@weaveintel/core';
import { Buffer } from 'node:buffer';
import { createSearchRouter, type SearchProviderConfig } from '@weaveintel/tools-search';
import { createInMemoryTemporalStore, createTimeTools, type TemporalStore } from '@weaveintel/tools-time';
import { createBrowserTools, createAutomationTools, createBrowserAuthTools } from '@weaveintel/tools-browser';
import { statsNzToolMap } from '@weaveintel/tools-http';
import { canUseTool, normalizePersona } from './rbac.js';
import type { ExecutionLanguage } from '@weaveintel/sandbox';
import { getCSE } from './cse.js';

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
};

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
}

export function filterToolNamesByPersona(toolNames: string[], persona: string | null | undefined): string[] {
  return toolNames.filter((toolName) => canUseTool(persona, toolName));
}

/**
 * Create a ToolRegistry pre-loaded with the selected built-in tools
 * plus any custom tools provided.
 */
export function createToolRegistry(toolNames: string[], customTools?: Tool[], opts?: ToolRegistryOptions): ToolRegistry {
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
