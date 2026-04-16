/**
 * @weaveintel/sandbox/cse — AI agent tools
 *
 * Exposes CSE capabilities as tool-calling functions that LLM agents can
 * invoke. The tools follow the same schema convention used throughout
 * WeaveIntel — they are plain async functions with typed inputs that can
 * be wrapped by any tool adapter (MCP, function-calling, etc.).
 *
 * Tools:
 *   cse_run_code        — Execute code in an isolated container
 *   cse_run_browser     — Run a Playwright browser automation script
 *   cse_session_status  — Get status of the current chat's sandbox session
 *   cse_end_session     — Terminate the sandbox session for a chat
 */

import type { ComputeSandboxEngine } from './executor.js';
import type { ExecutionLanguage } from './types.js';

// ─── Tool schemas (JSON-Schema compatible) ────────────────────

export const CSE_TOOL_DEFINITIONS = [
  {
    name: 'cse_run_code',
    description:
      'ACTUALLY EXECUTES code in a real isolated Docker container and returns the real stdout/stderr. ' +
      'Use this whenever the user wants to run, execute, or test a script — this is NOT a simulation. ' +
      'Supports Python, JavaScript, TypeScript, Bash. Pass the complete code as a string. ' +
      'The container has no internet access by default. Artifacts are returned alongside output.',
    parameters: {
      type: 'object' as const,
      required: ['code'],
      properties: {
        code: {
          type: 'string',
          description: 'The code to execute.',
        },
        language: {
          type: 'string',
          enum: ['python', 'javascript', 'typescript', 'bash', 'shell'],
          description: 'Programming language. Default: python.',
        },
        chatId: {
          type: 'string',
          description: 'Chat ID for session affinity. Reuses the same container across turns.',
        },
        files: {
          type: 'array',
          description: 'Files to inject into /workspace before running.',
          items: {
            type: 'object',
            required: ['name', 'content'],
            properties: {
              name: { type: 'string', description: 'Filename (relative path within /workspace).' },
              content: { type: 'string', description: 'File content (UTF-8 or base-64 binary).' },
              binary: { type: 'boolean', description: 'Set true if content is base-64-encoded.' },
            },
          },
        },
        timeoutMs: {
          type: 'number',
          description: 'Execution timeout in milliseconds. Default from CSE config.',
        },
        networkAccess: {
          type: 'boolean',
          description: 'Allow outbound network access. Default: false.',
        },
      },
    },
  },
  {
    name: 'cse_run_browser',
    description:
      'Run a Playwright browser automation script inside a sandboxed container with Chromium. ' +
      'The script has access to the full Playwright API. Use this for web scraping, screenshots, ' +
      'or browser-based testing when browser automation is enabled.',
    parameters: {
      type: 'object' as const,
      required: ['script'],
      properties: {
        script: {
          type: 'string',
          description: 'Python or JavaScript Playwright script to execute.',
        },
        language: {
          type: 'string',
          enum: ['python', 'javascript'],
          description: 'Script language. Default: python.',
        },
        chatId: {
          type: 'string',
          description: 'Chat ID for session affinity.',
        },
        networkAccess: {
          type: 'boolean',
          description: 'Allow outbound network (required for web scraping). Default: true for browser.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Timeout in ms. Default from CSE config.',
        },
      },
    },
  },
  {
    name: 'cse_session_status',
    description: 'Get the status of the compute sandbox session for a chat.',
    parameters: {
      type: 'object' as const,
      required: ['chatId'],
      properties: {
        chatId: { type: 'string', description: 'The chat ID to query.' },
      },
    },
  },
  {
    name: 'cse_end_session',
    description: 'Terminate the sandbox session for a chat, freeing container resources.',
    parameters: {
      type: 'object' as const,
      required: ['chatId'],
      properties: {
        chatId: { type: 'string', description: 'The chat ID whose session should be terminated.' },
      },
    },
  },
] as const;

// ─── Tool handlers ────────────────────────────────────────────

export interface CSEToolContext {
  cse: ComputeSandboxEngine;
  userId?: string;
  chatId?: string;
}

export async function handleCSETool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: CSEToolContext,
): Promise<unknown> {
  const { cse, userId, chatId } = ctx;

  switch (toolName) {
    case 'cse_run_code': {
      const code = String(args['code'] ?? '');
      const language = (args['language'] as ExecutionLanguage | undefined) ?? 'python';
      const effectiveChatId = (args['chatId'] as string | undefined) ?? chatId;

      const result = await cse.run({
        code,
        language,
        userId,
        chatId: effectiveChatId,
        files: args['files'] as any,
        timeoutMs: args['timeoutMs'] as number | undefined,
        networkAccess: args['networkAccess'] as boolean | undefined,
        withBrowser: false,
      });

      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        output: result.output,
        error: result.error,
        artifacts: result.artifacts.map((a) => ({
          name: a.name,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          // Omit data from the tool result to keep tokens down;
          // clients can fetch artifacts via the API.
        })),
        durationMs: result.durationMs,
        sessionId: result.sessionId,
        provider: result.providerInfo.provider,
      };
    }

    case 'cse_run_browser': {
      if (!cse.supportsBrowser) {
        return { error: 'Browser automation is not available with the current CSE provider.' };
      }

      const script = String(args['script'] ?? '');
      const language = ((args['language'] as string | undefined) === 'javascript'
        ? 'javascript'
        : 'python') as ExecutionLanguage;
      const effectiveChatId = (args['chatId'] as string | undefined) ?? chatId;

      const result = await cse.run({
        code: script,
        language,
        userId,
        chatId: effectiveChatId,
        timeoutMs: args['timeoutMs'] as number | undefined,
        // Browser scripts typically need network access
        networkAccess: (args['networkAccess'] as boolean | undefined) ?? true,
        withBrowser: true,
      });

      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        artifacts: result.artifacts.map((a) => ({ name: a.name, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
        durationMs: result.durationMs,
        error: result.error,
      };
    }

    case 'cse_session_status': {
      const targetChatId = (args['chatId'] as string | undefined) ?? chatId;
      const allSessions = cse.listSessions();
      const session = allSessions.find((s) => s.chatId === targetChatId);
      if (!session) return { active: false, chatId: targetChatId };
      return { active: true, ...session };
    }

    case 'cse_end_session': {
      const targetChatId = (args['chatId'] as string | undefined) ?? chatId;
      if (targetChatId) await cse.terminateChatSession(targetChatId, userId);
      return { terminated: true, chatId: targetChatId };
    }

    default:
      throw new Error(`Unknown CSE tool: ${toolName}`);
  }
}

/**
 * Create a tool registry entry compatible with the @weaveintel/tools pattern.
 * Pass this to your agent's tool registry to enable CSE tool calls.
 */
export function createCSETools(ctx: CSEToolContext) {
  return CSE_TOOL_DEFINITIONS.map((def) => ({
    ...def,
    handler: (args: Record<string, unknown>) => handleCSETool(def.name, args, ctx),
  }));
}
