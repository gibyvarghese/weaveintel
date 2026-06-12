/**
 * geneWeave — A2A (Agent-to-Agent) routes (W6)
 *
 * Exposes geneWeave's primary agent as an A2A-compatible server surface:
 *
 *   GET  /.well-known/agent.json  — Agent Card discovery (public)
 *   POST /api/a2a/tasks           — Submit a task (Bearer JWT required)
 *
 * The `/tasks` endpoint accepts an A2ATask body and delegates to the chat
 * engine's agent mode, returning an A2ATaskResult. Streaming is not exposed
 * over this surface (callers receive a completed result synchronously).
 *
 * Auth: Bearer token validated via the same JWT mechanism as the chat API.
 * CSRF is not required for A2A endpoints (machine-to-machine, no cookies).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { newUUIDv7, weaveContext } from '@weaveintel/core';
import type { A2ATask, A2ATaskResult } from '@weaveintel/core';
import type { DatabaseAdapter } from '../db.js';
import type { ChatEngine } from '../chat.js';
import { json, readBody } from '../server-core.js';
import type { Router } from '../server-core.js';
import { settingsFromRow, getOrCreateModel } from '../chat-runtime.js';

const AGENT_VERSION = '1.0.0';

/**
 * Build the A2A Agent Card for geneWeave. The URL is constructed from the
 * `baseUrl` option so it matches the deployment origin.
 */
function buildAgentCard(baseUrl: string) {
  return {
    name: 'geneweave',
    description: 'geneWeave — Intelligent AI orchestration assistant powered by weaveIntel',
    url: `${baseUrl}/api/a2a`,
    version: AGENT_VERSION,
    capabilities: ['text', 'tool-calling', 'supervisor', 'ensemble', 'reflection'],
    skills: [
      {
        name: 'chat',
        description: 'General-purpose conversational AI with optional tool use and agent modes',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The user message or goal' },
            systemPrompt: { type: 'string', description: 'Optional system prompt override' },
          },
          required: ['message'],
        },
      },
    ],
    authentication: {
      type: 'bearer',
    },
  };
}

export function registerA2ARoutes(
  router: Router,
  db: DatabaseAdapter,
  chatEngine: ChatEngine,
  options?: { baseUrl?: string },
): void {
  const baseUrl = options?.baseUrl ?? 'http://localhost:3000';

  // ── Well-known discovery ──────────────────────────────────────────────────

  // Standard A2A path per current A2A spec.
  router.get('/.well-known/agent-card.json', async (_req, res) => {
    json(res, 200, buildAgentCard(baseUrl));
  });

  // Legacy path — kept for backward compatibility.
  router.get('/.well-known/agent.json', async (_req, res) => {
    json(res, 200, buildAgentCard(baseUrl));
  });

  // ── Task submission ───────────────────────────────────────────────────────

  // Bearer-authenticated machine-to-machine endpoint — CSRF not required.
  router.post('/api/a2a/tasks', async (req, res, _params, auth) => {
    if (!auth) {
      json(res, 401, { error: 'Bearer token required' });
      return;
    }

    let task: A2ATask;
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed['id'] || !parsed['input']) {
        json(res, 400, { error: 'Invalid A2A task: must have id and input fields' });
        return;
      }
      task = parsed as A2ATask;
    } catch {
      json(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    // Extract text content from A2A task input parts.
    const userContent = task.input.parts
      .map((p) => (p.type === 'text' ? p.text : p.type === 'data' ? JSON.stringify(p.data) : ''))
      .filter(Boolean)
      .join('\n');

    if (!userContent.trim()) {
      json(res, 400, { error: 'Task input must contain at least one text part' });
      return;
    }

    // Build a synthetic context for this task.
    const ctx = weaveContext({ userId: auth.userId, metadata: { a2aTaskId: task.id, requestId: newUUIDv7() } });

    try {
      // Use the user's default settings, falling back to agent mode so the
      // A2A endpoint always gets tool-calling behaviour.
      const settingsRow = await db.getChatSettings(task.metadata?.['chatId'] as string | undefined ?? '');
      const settings = settingsFromRow(settingsRow);
      if (settings.mode === 'direct') {
        settings.mode = 'agent';
      }

      // Resolve model: honour a `model` hint in task metadata (e.g. "openai/gpt-4o-mini"),
      // otherwise fall back to the engine's configured default.
      const engineConfig = (chatEngine as unknown as { config: { defaultProvider: string; defaultModel: string; providers: Record<string, unknown> } }).config;
      const modelHint = task.metadata?.['model'] as string | undefined;
      let resolvedProvider = engineConfig.defaultProvider;
      let resolvedModel = engineConfig.defaultModel;
      if (modelHint && modelHint.includes('/')) {
        const slashIdx = modelHint.indexOf('/');
        resolvedProvider = modelHint.slice(0, slashIdx);
        resolvedModel = modelHint.slice(slashIdx + 1);
      }
      const providerCfg = (engineConfig.providers[resolvedProvider] ?? {}) as Record<string, unknown>;
      const model = await getOrCreateModel(resolvedProvider, resolvedModel, providerCfg);

      // Delegate to the ChatEngine's runAgent method via the internal API.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const internalEngine = chatEngine as any;

      const syntheticChatId = task.metadata?.['chatId'] as string | undefined ?? `a2a-${task.id}`;
      // Pass the user message in the messages array so the agent has at least
      // one message to send to the model (the regular chat flow injects this
      // via patchLatestUserMessage on the DB-loaded history).
      const a2aMessages = [{ role: 'user' as const, content: userContent }];
      const { result } = await internalEngine.runAgent(
        ctx,
        model,
        auth.userId,
        syntheticChatId,
        'agent_worker',
        a2aMessages,
        userContent,
        settings,
      );

      const taskResult: A2ATaskResult = {
        id: task.id,
        status: result.status === 'completed' ? 'completed' : 'failed',
        output: {
          role: 'agent',
          parts: [{ type: 'text', text: result.output }],
        },
      };
      json(res, 200, taskResult);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const taskResult: A2ATaskResult = {
        id: task.id,
        status: 'failed',
        error: message,
      };
      json(res, 500, taskResult);
    }
  }, { csrf: false });

  // ── Task status (stub — geneWeave tasks are synchronous) ─────────────────

  router.get('/api/a2a/tasks/:taskId', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Bearer token required' }); return; }
    // Synchronous A2A server — no persistent task state.
    json(res, 404, { error: 'Task not found. geneWeave A2A tasks are synchronous.' });
  });
}
