/**
 * @weaveintel/a2a — Agent-to-Agent protocol implementation (v1.0)
 *
 * Provides an A2A client for remote agent communication and an in-process bus
 * for local agent-to-agent delegation.
 *
 * Wire format: REST over HTTPS (Phase 1). JSON-RPC 2.0 is Phase 2.
 * All requests include `A2A-Version: 1.0` header.
 */

import type {
  A2AClient,
  A2AServer,
  A2ATask,
  A2ATaskSendParams,
  A2AStreamEvent,
  A2AListTasksFilter,
  A2ATaskPage,
  A2ATaskResult,
  A2ATaskLegacy,
  AgentCard,
  InternalA2ABus,
  ExecutionContext,
} from '@weaveintel/core';
import { WeaveIntelError, weaveResolveTracer, newUUIDv7 } from '@weaveintel/core';
import { a2aFetch, a2aFetchStream } from './_fetch.js';

const A2A_VERSION_HEADER = 'A2A-Version';
const A2A_VERSION = '1.0';

function a2aHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'Content-Type': 'application/json', [A2A_VERSION_HEADER]: A2A_VERSION, ...extra };
}

async function withObservedSpan<T>(
  ctx: ExecutionContext,
  name: string,
  attributes: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = weaveResolveTracer(ctx);
  if (!tracer) return fn();
  return tracer.withSpan(ctx, name, () => fn(), attributes);
}

// ─── HTTP-based A2A client ───────────────────────────────────

export function weaveA2AClient(): A2AClient {
  return {
    // ── Discovery ─────────────────────────────────────────────────────────────

    async discover(url: string): Promise<AgentCard> {
      const base = url.replace(/\/$/, '');
      // A2A v1.0 spec path; fall back to legacy agent.json for older servers
      const v1Path = `${base}/.well-known/agent-card.json`;
      const legacyPath = `${base}/.well-known/agent.json`;

      let response = await a2aFetch(v1Path, { headers: { [A2A_VERSION_HEADER]: A2A_VERSION } });
      if (!response.ok && response.status === 404) {
        response = await a2aFetch(legacyPath, { headers: { [A2A_VERSION_HEADER]: A2A_VERSION } });
      }
      if (!response.ok) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A discovery failed at ${v1Path}: HTTP ${response.status}`,
        });
      }
      const card = await response.json() as AgentCard;

      if (!card || typeof card.name !== 'string' || !card.name) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A agent card from ${v1Path} is missing a valid "name" field`,
        });
      }

      // Resolve the endpoint URL from card: supportedInterfaces[0].url (v1.0)
      // or legacy card.url (v0.3).
      const cardEndpointUrl = card.supportedInterfaces?.[0]?.url ?? card.url;
      if (!cardEndpointUrl) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A agent card from ${v1Path} has no "supportedInterfaces[0].url" or "url" field`,
        });
      }

      // H-14 origin check: the card's endpoint must share origin with discovery URL.
      try {
        const requestedOrigin = new URL(v1Path).origin;
        const cardOrigin = new URL(cardEndpointUrl).origin;
        if (cardOrigin !== requestedOrigin) {
          throw new WeaveIntelError({
            code: 'PROTOCOL_ERROR',
            message: `A2A agent card URL origin mismatch: card claims "${cardOrigin}" but was fetched from "${requestedOrigin}". Possible open-redirect or SSRF.`,
          });
        }
      } catch (err) {
        if (err instanceof WeaveIntelError) throw err;
        // Skip origin check for non-http schemes (e.g. a2a://) used in tests.
        if (!cardEndpointUrl.startsWith('http')) return card;
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A agent card endpoint is not a valid URL: ${cardEndpointUrl}`,
        });
      }

      return card;
    },

    // ── v1.0 methods ──────────────────────────────────────────────────────────

    async sendMessage(ctx: ExecutionContext, agentUrl: string, params: A2ATaskSendParams): Promise<A2ATask> {
      const taskUrl = agentUrl.replace(/\/$/, '') + '/tasks';
      const response = await withObservedSpan(
        ctx,
        'a2a.client.send_message',
        { agentUrl, contextId: params.message.contextId },
        () => a2aFetch(taskUrl, {
          method: 'POST',
          headers: a2aHeaders(),
          body: JSON.stringify(params),
          signal: ctx.signal,
        }),
      );
      if (!response.ok) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A sendMessage failed: HTTP ${response.status} ${response.statusText}`,
        });
      }
      return response.json() as Promise<A2ATask>;
    },

    async *streamMessage(ctx: ExecutionContext, agentUrl: string, params: A2ATaskSendParams): AsyncIterable<A2AStreamEvent> {
      const taskUrl = agentUrl.replace(/\/$/, '') + '/tasks/stream';
      const response = await withObservedSpan(
        ctx,
        'a2a.client.stream_message',
        { agentUrl, contextId: params.message.contextId },
        () => a2aFetchStream(taskUrl, {
          method: 'POST',
          headers: a2aHeaders({ Accept: 'text/event-stream' }),
          body: JSON.stringify(params),
          signal: ctx.signal,
        }),
      );
      if (!response.ok || !response.body) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A streamMessage failed: HTTP ${response.status}`,
        });
      }

      yield* parseSseStream<A2AStreamEvent>(response.body);
    },

    async getTask(ctx: ExecutionContext, agentUrl: string, taskId: string, historyLength?: number): Promise<A2ATask> {
      const qs = historyLength !== undefined ? `?historyLength=${historyLength}` : '';
      const url = agentUrl.replace(/\/$/, '') + `/tasks/${encodeURIComponent(taskId)}${qs}`;
      const response = await withObservedSpan(
        ctx,
        'a2a.client.get_task',
        { agentUrl, taskId },
        () => a2aFetch(url, { headers: { [A2A_VERSION_HEADER]: A2A_VERSION }, signal: ctx.signal }),
      );
      if (!response.ok) {
        throw new WeaveIntelError({
          code: response.status === 404 ? 'NOT_FOUND' : 'PROTOCOL_ERROR',
          message: `A2A getTask failed: HTTP ${response.status}`,
        });
      }
      return response.json() as Promise<A2ATask>;
    },

    async listTasks(ctx: ExecutionContext, agentUrl: string, filter?: A2AListTasksFilter): Promise<A2ATaskPage> {
      const url = agentUrl.replace(/\/$/, '') + '/tasks';
      const params = new URLSearchParams();
      if (filter?.contextId) params.set('contextId', filter.contextId);
      if (filter?.state) params.set('state', filter.state);
      if (filter?.statusTimestampAfter) params.set('statusTimestampAfter', filter.statusTimestampAfter);
      if (filter?.pageSize) params.set('pageSize', String(filter.pageSize));
      if (filter?.pageToken) params.set('pageToken', filter.pageToken);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const response = await withObservedSpan(
        ctx,
        'a2a.client.list_tasks',
        { agentUrl },
        () => a2aFetch(`${url}${qs}`, { headers: { [A2A_VERSION_HEADER]: A2A_VERSION }, signal: ctx.signal }),
      );
      if (!response.ok) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A listTasks failed: HTTP ${response.status}`,
        });
      }
      return response.json() as Promise<A2ATaskPage>;
    },

    async cancelTask(ctx: ExecutionContext, agentUrl: string, taskId: string): Promise<void> {
      const url = agentUrl.replace(/\/$/, '') + `/tasks/${encodeURIComponent(taskId)}/cancel`;
      const response = await withObservedSpan(
        ctx,
        'a2a.client.cancel_task',
        { agentUrl, taskId },
        () => a2aFetch(url, {
          method: 'POST',
          headers: { [A2A_VERSION_HEADER]: A2A_VERSION },
          signal: ctx.signal,
        }),
      );
      if (!response.ok) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A cancelTask failed for "${taskId}": HTTP ${response.status} ${response.statusText}`,
        });
      }
    },

    async *subscribeToTask(ctx: ExecutionContext, agentUrl: string, taskId: string): AsyncIterable<A2AStreamEvent> {
      const url = agentUrl.replace(/\/$/, '') + `/tasks/${encodeURIComponent(taskId)}/subscribe`;
      const response = await withObservedSpan(
        ctx,
        'a2a.client.subscribe_task',
        { agentUrl, taskId },
        () => a2aFetchStream(url, {
          headers: { [A2A_VERSION_HEADER]: A2A_VERSION, Accept: 'text/event-stream' },
          signal: ctx.signal,
        }),
      );
      if (!response.ok || !response.body) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A subscribeToTask failed: HTTP ${response.status}`,
        });
      }
      yield* parseSseStream<A2AStreamEvent>(response.body);
    },

    // ── Deprecated v0.3 compat ────────────────────────────────────────────────

    /** @deprecated Use sendMessage(). */
    async sendTask(ctx: ExecutionContext, agentUrl: string, task: A2ATaskLegacy): Promise<A2ATaskResult> {
      const params: A2ATaskSendParams = { message: task.input, metadata: task.metadata };
      const result = await this.sendMessage(ctx, agentUrl, params);
      return {
        id: task.id,
        status: result.status.state === 'TASK_STATE_COMPLETED' ? 'completed' : 'failed',
        output: result.artifacts[0]
          ? { role: 'agent', parts: result.artifacts[0].parts as A2ATaskResult['output'] extends { parts: infer P } ? P : never }
          : undefined,
        error: result.status.state !== 'TASK_STATE_COMPLETED'
          ? result.status.message?.parts[0]?.text
          : undefined,
      };
    },

    /** @deprecated Use streamMessage(). */
    async *streamTask(ctx: ExecutionContext, agentUrl: string, task: A2ATaskLegacy): AsyncIterable<A2ATaskResult> {
      const params: A2ATaskSendParams = { message: task.input, metadata: task.metadata };
      for await (const event of this.streamMessage(ctx, agentUrl, params)) {
        if ('task' in event) {
          const t = event.task;
          const outputText = t.artifacts[0]?.parts[0]?.text;
          yield {
            id: task.id,
            status: t.status.state === 'TASK_STATE_COMPLETED' ? 'completed' : 'failed',
            output: outputText ? { role: 'agent', parts: [{ text: outputText }] } : undefined,
          };
        } else if ('statusUpdate' in event) {
          yield { id: task.id, status: 'working' };
        } else if ('artifactUpdate' in event) {
          const text = event.artifactUpdate.artifact.parts[0]?.text;
          if (text) {
            yield { id: task.id, status: 'working', output: { role: 'agent', parts: [{ text }] }, metadata: { partial: true } };
          }
        }
      }
    },

    /** @deprecated Use getTask(). */
    async getTaskStatus(ctx: ExecutionContext, agentUrl: string, taskId: string): Promise<A2ATaskResult> {
      const task = await this.getTask(ctx, agentUrl, taskId);
      const outputText = task.artifacts[0]?.parts[0]?.text;
      return {
        id: taskId,
        status: task.status.state === 'TASK_STATE_COMPLETED' ? 'completed'
          : task.status.state === 'TASK_STATE_FAILED' ? 'failed'
          : task.status.state === 'TASK_STATE_WORKING' ? 'working'
          : 'submitted',
        output: outputText ? { role: 'agent', parts: [{ text: outputText }] } : undefined,
      };
    },
  };
}

// ─── SSE stream parser ───────────────────────────────────────

async function* parseSseStream<T>(body: ReadableStream<Uint8Array>): AsyncIterable<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          // v1.0: stream closes on terminal state — no [DONE] sentinel
          if (data && data !== '[DONE]') {
            try {
              yield JSON.parse(data) as T;
            } catch {
              // malformed JSON — skip
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Internal A2A bus (in-process delegation) ────────────────

export function weaveA2ABus(): InternalA2ABus {
  const agents = new Map<string, A2AServer>();

  return {
    register(name: string, handler: A2AServer): void {
      agents.set(name, handler);
    },

    unregister(name: string): void {
      agents.delete(name);
    },

    async send(ctx: ExecutionContext, target: string, params: A2ATaskSendParams): Promise<A2ATask> {
      const agent = agents.get(target);
      if (!agent) {
        throw new WeaveIntelError({
          code: 'NOT_FOUND',
          message: `A2A agent not found: "${target}". Available: ${[...agents.keys()].join(', ')}`,
        });
      }
      // Primary v1.0 path
      if (agent.handleMessage) {
        return agent.handleMessage(ctx, params);
      }
      // Deprecated fallback: wrap for old handleTask implementations
      if (agent.handleTask) {
        const taskId = newUUIDv7();
        const legacyResult = await agent.handleTask(ctx, {
          id: taskId,
          input: params.message,
          metadata: params.metadata,
        });
        return {
          id: legacyResult.id,
          contextId: params.message.contextId ?? legacyResult.id,
          status: {
            state: legacyResult.status === 'completed' ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_FAILED',
            timestamp: new Date().toISOString(),
          },
          artifacts: legacyResult.output
            ? [{ artifactId: `${legacyResult.id}-output`, name: 'output', parts: legacyResult.output.parts }]
            : [],
          history: [params.message],
        };
      }
      throw new WeaveIntelError({
        code: 'PROTOCOL_ERROR',
        message: `A2A agent "${target}" implements neither handleMessage nor handleTask`,
      });
    },

    discover(name: string): AgentCard | undefined {
      return agents.get(name)?.card;
    },

    listAgents(): AgentCard[] {
      return [...agents.values()].map((a) => a.card);
    },
  };
}
