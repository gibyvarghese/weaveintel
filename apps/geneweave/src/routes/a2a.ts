/**
 * geneWeave — A2A (Agent-to-Agent) routes (v1.0, Phase 3)
 *
 * Phase 3: Task store + full state machine + SubscribeToTask.
 *
 * Endpoints:
 *   GET  /.well-known/agent-card.json  — v1.0 Agent Card (public)
 *   GET  /.well-known/agent.json       — legacy alias (backward compat)
 *   POST /api/a2a                      — JSON-RPC 2.0 dispatcher (v1.0 primary)
 *
 * Backward-compat REST endpoints still available:
 *   POST /api/a2a/tasks                — submit a task (A2ATaskSendParams body)
 *   GET  /api/a2a/tasks/:taskId        — fetch task from store (real, not a stub)
 *
 * A2A v1.0 methods accepted at POST /api/a2a:
 *   SendMessage, SendStreamingMessage, GetTask, ListTasks, CancelTask, SubscribeToTask
 *
 * Streaming:
 *   SendStreamingMessage returns text/event-stream with A2AStreamEvent JSON per line.
 *   SubscribeToTask reconnects to in-progress/pending tasks via the task store.
 *
 * Auth: Bearer token validated via the same JWT mechanism as the chat API.
 */

import { newUUIDv7, weaveContext } from '@weaveintel/core';
import type {
  A2ATask,
  A2ATaskSendParams,
  AgentCard,
} from '@weaveintel/core';
import {
  createA2ADispatcher,
  createInMemoryA2ATaskStore,
  streamToSse,
  SSE_KEEPALIVE,
} from '@weaveintel/a2a';
import type { A2ATaskStore } from '@weaveintel/a2a';
import type { DatabaseAdapter } from '../db.js';
import type { ChatEngine } from '../chat.js';
import { json, readBody } from '../server-core.js';
import type { Router } from '../server-core.js';
import { settingsFromRow, getOrCreateModel } from '../chat-runtime.js';

const AGENT_VERSION = '1.0.0';

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
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
      stateTransitionHistory: true,
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
    url: agentUrl, // backward-compat for v0.3 clients
  };
}

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

  // ── Well-known discovery ────────────────────────────────────────────────────

  router.get('/.well-known/agent-card.json', async (_req, res) => {
    json(res, 200, buildAgentCard(baseUrl));
  });

  router.get('/.well-known/agent.json', async (_req, res) => {
    json(res, 200, buildAgentCard(baseUrl));
  });

  // ── Task store (Phase 3) ─────────────────────────────────────────────────────
  // One in-memory store per server instance. Swap for createDurableA2ATaskStore(kv)
  // once a persistence slot is wired (Phase 4).
  const taskStore: A2ATaskStore = createInMemoryA2ATaskStore();

  // ── Build the JSON-RPC 2.0 dispatcher (lazily, so chatEngine is fully wired) ─

  let _dispatcher: ReturnType<typeof createA2ADispatcher> | null = null;

  function getDispatcher() {
    if (_dispatcher) return _dispatcher;
    const a2aImpl = buildGeneWeaveA2AServer(db, chatEngine, taskStore);
    _dispatcher = createA2ADispatcher(a2aImpl, taskStore);
    return _dispatcher;
  }

  // ── POST /api/a2a — JSON-RPC 2.0 primary endpoint (Phase 2) ────────────────

  router.post('/api/a2a', async (req, res, _params, auth) => {
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Bearer token required' } }));
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Could not read request body' } }));
      return;
    }

    const ctx = weaveContext({
      userId: auth.userId,
      metadata: { requestId: newUUIDv7() },
    });

    const a2aVersion = req.headers['a2a-version'] as string | undefined;
    const result = await getDispatcher()(ctx, { method: 'POST', body, headers: req.headers as Record<string, string>, a2aVersion });

    if (result.kind === 'json') {
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.data));
      return;
    }

    // SSE streaming response
    req.socket?.setTimeout(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Keepalive interval
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(SSE_KEEPALIVE);
    }, 15_000);

    try {
      for await (const chunk of streamToSse(result.events)) {
        if (res.writableEnded) break;
        res.write(chunk);
      }
    } catch {
      // Stream errors are already encoded as { task: failedTask } events
    } finally {
      clearInterval(keepalive);
      res.end();
    }
  }, { csrf: false });

  // ── POST /api/a2a/tasks — REST backward-compat (Phase 1 clients) ───────────

  router.post('/api/a2a/tasks', async (req, res, _params, auth) => {
    if (!auth) {
      json(res, 401, { error: 'Bearer token required' });
      return;
    }

    let sendParams: A2ATaskSendParams;
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed['message'] || typeof parsed['message'] !== 'object') {
        json(res, 400, { error: 'Invalid A2A params: must have message object' });
        return;
      }
      const msg = parsed['message'] as Record<string, unknown>;
      if (!Array.isArray(msg['parts'])) {
        json(res, 400, { error: 'Invalid A2A params: message.parts must be an array' });
        return;
      }
      sendParams = parsed as unknown as A2ATaskSendParams;
    } catch {
      json(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const userContent = extractPartsText(sendParams.message.parts);
    if (!userContent.trim()) {
      json(res, 400, { error: 'Task message must contain at least one text part' });
      return;
    }

    const task = await runAgentTask(db, chatEngine, auth.userId, sendParams, userContent);
    json(res, 200, task);
  }, { csrf: false });

  // ── GET /api/a2a/tasks/:taskId — REST backward-compat (real task store) ─────

  router.get('/api/a2a/tasks/:taskId', async (_req, res, params, auth) => {
    if (!auth) {
      json(res, 401, { error: 'Bearer token required' });
      return;
    }
    const taskId = params['taskId'] ?? 'unknown';
    const task = await taskStore.load(taskId);
    if (!task) {
      json(res, 404, { error: `Task not found: ${taskId}` });
      return;
    }
    json(res, 200, task);
  });
}

// ─── A2A server impl wrapping chat engine ────────────────────────────────────

import type { A2AServer, A2AStreamEvent, A2AMessage, A2AListTasksFilter } from '@weaveintel/core';
import { makeCompletedA2ATask, makeFailedA2ATask, weaveAudit } from '@weaveintel/core';

function buildGeneWeaveA2AServer(
  db: DatabaseAdapter,
  chatEngine: ChatEngine,
  store: A2ATaskStore,
): A2AServer {
  const card = (() => {
    const baseUrl = process.env['GENEWEAVE_BASE_URL'] ?? 'http://localhost:3000';
    const agentUrl = `${baseUrl}/api/a2a`;
    return {
      name: 'geneweave',
      description: 'geneWeave — Intelligent AI orchestration assistant powered by weaveIntel',
      version: AGENT_VERSION,
      skills: [{ id: 'general-chat', name: 'General Chat', description: 'Conversational AI with tool-calling' }],
      capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false, stateTransitionHistory: true },
      supportedInterfaces: [{ url: agentUrl, protocolBinding: 'JSONRPC' as const, protocolVersion: '1.0' }],
    };
  })();

  return {
    card,

    async handleMessage(ctx, params) {
      const taskId = newUUIDv7();
      const contextId = params.message.contextId ?? taskId;
      const history: A2AMessage[] = [params.message];
      const submittedAt = new Date().toISOString();

      // Persist SUBMITTED state
      await store.save({
        id: taskId, contextId,
        status: { state: 'TASK_STATE_SUBMITTED', timestamp: submittedAt },
        artifacts: [], history,
        metadata: { submittedAt },
      });

      // Transition to WORKING
      await store.update(taskId, {
        status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() },
      });

      void weaveAudit(ctx, { action: 'a2a.task.received', outcome: 'success', resource: 'geneweave', details: { taskId, contextId } });

      let task: A2ATask;
      try {
        const userContent = extractPartsText(params.message.parts);
        task = await runAgentTask(db, chatEngine, ctx.userId ?? 'a2a-anon', params, userContent, taskId, contextId);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        task = makeFailedA2ATask(taskId, contextId, error, history);
      }

      await store.save(task);
      return task;
    },

    async *handleStreamMessage(ctx, params): AsyncIterable<A2AStreamEvent> {
      const taskId = newUUIDv7();
      const contextId = params.message.contextId ?? taskId;
      const history: A2AMessage[] = [params.message];

      await store.save({
        id: taskId, contextId,
        status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
        artifacts: [], history,
      });

      // Emit WORKING status immediately
      const workingTs = new Date().toISOString();
      await store.update(taskId, { status: { state: 'TASK_STATE_WORKING', timestamp: workingTs } });
      yield {
        statusUpdate: {
          taskId,
          contextId,
          status: { state: 'TASK_STATE_WORKING', timestamp: workingTs },
        },
      };

      void weaveAudit(ctx, { action: 'a2a.task.stream.start', outcome: 'success', resource: 'geneweave', details: { taskId } });

      let task: A2ATask;
      try {
        const userContent = extractPartsText(params.message.parts);
        task = await runAgentTask(db, chatEngine, ctx.userId ?? 'a2a-anon', params, userContent, taskId, contextId);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        task = makeFailedA2ATask(taskId, contextId, error, history);
      }

      await store.save(task);

      // Emit artifact update
      if (task.artifacts.length > 0) {
        yield {
          artifactUpdate: {
            taskId,
            contextId,
            artifact: task.artifacts[0]!,
            append: false,
            lastChunk: true,
          },
        };
      }

      yield { task };
    },

    async getTask(_ctx, taskId) {
      return store.load(taskId);
    },

    async listTasks(_ctx, filter?: A2AListTasksFilter) {
      return store.list(filter);
    },

    async cancelTask(_ctx, taskId) {
      const existing = await store.load(taskId);
      if (!existing) return;
      await store.update(taskId, {
        status: { state: 'TASK_STATE_CANCELED', timestamp: new Date().toISOString() },
      });
    },

    async start() {},
    async stop() {},
  };
}

// ─── Shared chat engine runner ───────────────────────────────────────────────

async function runAgentTask(
  db: DatabaseAdapter,
  chatEngine: ChatEngine,
  userId: string,
  sendParams: A2ATaskSendParams,
  userContent: string,
  taskId?: string,
  contextId?: string,
): Promise<A2ATask> {
  const resolvedTaskId = taskId ?? newUUIDv7();
  const resolvedContextId = contextId ?? sendParams.message.contextId ?? resolvedTaskId;
  const receivedAt = new Date().toISOString();

  const ctx = weaveContext({
    userId,
    metadata: { a2aTaskId: resolvedTaskId, a2aContextId: resolvedContextId, requestId: newUUIDv7() },
  });

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

  const syntheticChatId = (sendParams.metadata?.['chatId'] as string | undefined) ?? `a2a-${resolvedTaskId}`;
  const { result } = await chatEngine.runAgentTask(
    ctx,
    model,
    userId,
    syntheticChatId,
    'agent_worker',
    [{ role: 'user' as const, content: userContent }],
    userContent,
    settings,
  );

  const completedAt = new Date().toISOString();
  const succeeded = result.status === 'completed';

  return {
    id: resolvedTaskId,
    contextId: resolvedContextId,
    status: {
      state: succeeded ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_FAILED',
      message: succeeded
        ? undefined
        : { role: 'agent', parts: [{ text: result.output || 'Agent task failed' }] },
      timestamp: completedAt,
    },
    artifacts: succeeded
      ? [{ artifactId: `${resolvedTaskId}-output`, name: 'output', parts: [{ text: result.output }] }]
      : [],
    history: [
      { role: 'user', parts: sendParams.message.parts, contextId: resolvedContextId, messageId: newUUIDv7(), metadata: { timestamp: receivedAt } },
      { role: 'agent', parts: [{ text: result.output }], contextId: resolvedContextId, messageId: newUUIDv7(), metadata: { timestamp: completedAt } },
    ],
    metadata: { submittedAt: receivedAt },
  };
}
