/**
 * geneWeave — A2A (Agent-to-Agent) routes (v1.0)
 *
 * Exposes geneWeave as an A2A v1.0-compatible agent surface:
 *
 *   GET  /.well-known/agent-card.json  — v1.0 Agent Card (public)
 *   GET  /.well-known/agent.json       — legacy alias (backward compat)
 *   POST /api/a2a/tasks                — submit a task (Bearer JWT required)
 *   GET  /api/a2a/tasks/:taskId        — poll task status (Bearer JWT required)
 *
 * Wire format: REST (Phase 1). JSON-RPC 2.0 is Phase 2.
 * Task states: A2A v1.0 SCREAMING_SNAKE_CASE.
 *
 * Auth: Bearer token validated via the same JWT mechanism as the chat API.
 * CSRF is not required for A2A endpoints (machine-to-machine, no cookies).
 */

import { newUUIDv7, weaveContext } from '@weaveintel/core';
import type {
  A2ATask,
  A2ATaskSendParams,
  AgentCard,
} from '@weaveintel/core';
import type { DatabaseAdapter } from '../db.js';
import type { ChatEngine } from '../chat.js';
import { json, readBody } from '../server-core.js';
import type { Router } from '../server-core.js';
import { settingsFromRow, getOrCreateModel } from '../chat-runtime.js';

const AGENT_VERSION = '1.0.0';

/**
 * Build a v1.0-compliant Agent Card for geneWeave.
 */
function buildAgentCard(baseUrl: string): AgentCard {
  const agentUrl = `${baseUrl}/api/a2a`;
  return {
    name: 'geneweave',
    description: 'geneWeave — Intelligent AI orchestration assistant powered by weaveIntel',
    version: AGENT_VERSION,
    skills: [
      {
        id: 'general-chat',
        name: 'General Chat',
        description: 'Conversational AI with tool-calling, supervisor, and ensemble agent modes',
        tags: ['chat', 'tool-calling', 'orchestration', 'supervisor'],
        examples: [
          'Analyse this dataset and plot key trends',
          'Search the web for the latest news on renewable energy',
          'Review my code and suggest improvements',
        ],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
      },
    ],
    capabilities: {
      streaming: false,      // Phase 2
      pushNotifications: false,
      extendedAgentCard: false,
      stateTransitionHistory: false,
    },
    supportedInterfaces: [
      {
        url: agentUrl,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      },
    ],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer' },
    },
    security: [{ bearer: [] }],
    // Backward-compat field (v0.3 clients that check card.url)
    url: agentUrl,
  };
}

/** Extract text from v1.0 A2APart array (field-presence, no `type` discriminator). */
function extractPartsText(parts: ReadonlyArray<{ text?: string; data?: unknown; url?: string; raw?: string; filename?: string }>): string {
  return parts
    .map((p) => {
      if (typeof p.text === 'string') return p.text;
      if (p.data !== undefined) return JSON.stringify(p.data);
      if (typeof p.url === 'string') return `[File: ${p.filename ?? p.url}]`;
      if (typeof p.raw === 'string') return '[Binary content]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function registerA2ARoutes(
  router: Router,
  db: DatabaseAdapter,
  chatEngine: ChatEngine,
  options?: { baseUrl?: string },
): void {
  const baseUrl = options?.baseUrl ?? 'http://localhost:3000';

  // ── Well-known discovery ──────────────────────────────────────────────────

  // v1.0 canonical path
  router.get('/.well-known/agent-card.json', async (_req, res) => {
    json(res, 200, buildAgentCard(baseUrl));
  });

  // Legacy path kept for backward compat with v0.3 clients
  router.get('/.well-known/agent.json', async (_req, res) => {
    json(res, 200, buildAgentCard(baseUrl));
  });

  // ── Task submission ───────────────────────────────────────────────────────

  router.post('/api/a2a/tasks', async (req, res, _params, auth) => {
    if (!auth) {
      json(res, 401, { error: 'Bearer token required' });
      return;
    }

    let sendParams: A2ATaskSendParams;
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      // Accept v1.0 A2ATaskSendParams: { message: { role, parts } }
      if (parsed['message'] && typeof parsed['message'] === 'object') {
        const msg = parsed['message'] as Record<string, unknown>;
        if (!Array.isArray(msg['parts'])) {
          json(res, 400, { error: 'Invalid A2A params: message.parts must be an array' });
          return;
        }
        sendParams = parsed as unknown as A2ATaskSendParams;
      } else {
        json(res, 400, { error: 'Invalid A2A params: must have message.parts array' });
        return;
      }
    } catch {
      json(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const userContent = extractPartsText(sendParams.message.parts);
    if (!userContent.trim()) {
      json(res, 400, { error: 'Task message must contain at least one text part' });
      return;
    }

    const taskId = newUUIDv7();
    const contextId = sendParams.message.contextId ?? taskId;
    const receivedAt = new Date().toISOString();

    const ctx = weaveContext({
      userId: auth.userId,
      metadata: {
        a2aTaskId: taskId,
        a2aContextId: contextId,
        requestId: newUUIDv7(),
      },
    });

    try {
      const settingsRow = await db.getChatSettings(
        (sendParams.metadata?.['chatId'] as string | undefined) ?? '',
      );
      const settings = settingsFromRow(settingsRow);
      if (settings.mode === 'direct') settings.mode = 'agent';

      const engineConfig = (chatEngine as unknown as {
        config: { defaultProvider: string; defaultModel: string; providers: Record<string, unknown> };
      }).config;
      const modelHint = sendParams.metadata?.['model'] as string | undefined;
      let resolvedProvider = engineConfig.defaultProvider;
      let resolvedModel = engineConfig.defaultModel;
      if (modelHint?.includes('/')) {
        const slashIdx = modelHint.indexOf('/');
        resolvedProvider = modelHint.slice(0, slashIdx);
        resolvedModel = modelHint.slice(slashIdx + 1);
      }
      const providerCfg = (engineConfig.providers[resolvedProvider] ?? {}) as Record<string, unknown>;
      const model = await getOrCreateModel(resolvedProvider, resolvedModel, providerCfg);

      const syntheticChatId =
        (sendParams.metadata?.['chatId'] as string | undefined) ?? `a2a-${taskId}`;
      const { result } = await chatEngine.runAgentTask(
        ctx,
        model,
        auth.userId,
        syntheticChatId,
        'agent_worker',
        [{ role: 'user' as const, content: userContent }],
        userContent,
        settings,
      );

      const completedAt = new Date().toISOString();
      const succeeded = result.status === 'completed';

      const task: A2ATask = {
        id: taskId,
        contextId,
        status: {
          state: succeeded ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_FAILED',
          message: succeeded
            ? undefined
            : { role: 'agent', parts: [{ text: result.output || 'Agent task failed' }] },
          timestamp: completedAt,
        },
        artifacts: succeeded
          ? [{ artifactId: `${taskId}-output`, name: 'output', parts: [{ text: result.output }] }]
          : [],
        history: [
          {
            role: 'user',
            parts: sendParams.message.parts,
            contextId,
            messageId: newUUIDv7(),
            metadata: { timestamp: receivedAt },
          },
          {
            role: 'agent',
            parts: [{ text: result.output }],
            contextId,
            messageId: newUUIDv7(),
            metadata: { timestamp: completedAt },
          },
        ],
        metadata: { submittedAt: receivedAt },
      };

      json(res, 200, task);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failedTask: A2ATask = {
        id: taskId,
        contextId,
        status: {
          state: 'TASK_STATE_FAILED',
          message: { role: 'agent', parts: [{ text: message }] },
          timestamp: new Date().toISOString(),
        },
        artifacts: [],
        history: [
          {
            role: 'user',
            parts: sendParams.message.parts,
            contextId,
            messageId: newUUIDv7(),
            metadata: { timestamp: receivedAt },
          },
        ],
        metadata: { submittedAt: receivedAt },
      };
      json(res, 500, failedTask);
    }
  }, { csrf: false });

  // ── Task status poll ─────────────────────────────────────────────────────

  router.get('/api/a2a/tasks/:taskId', async (_req, res, params, auth) => {
    if (!auth) {
      json(res, 401, { error: 'Bearer token required' });
      return;
    }
    const taskId = params['taskId'];
    // geneWeave A2A tasks are synchronous: the completed result was delivered
    // in the POST response. Callers that poll for status receive COMPLETED.
    // Phase 2 will implement proper async task persistence and real polling.
    const stub: A2ATask = {
      id: taskId ?? 'unknown',
      contextId: taskId ?? 'unknown',
      status: {
        state: 'TASK_STATE_COMPLETED',
        timestamp: new Date().toISOString(),
      },
      artifacts: [],
      history: [],
      metadata: {
        note: 'geneWeave A2A tasks are synchronous — the final result was delivered in the POST response.',
      },
    };
    json(res, 200, stub);
  });
}
