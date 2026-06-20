/**
 * @weaveintel/a2a — Agent-to-Agent protocol implementation (v1.0, Phase 2)
 *
 * Phase 2 changes from Phase 1:
 *   - Wire format: JSON-RPC 2.0 over a single endpoint (all methods POST to agentUrl)
 *   - All methods use `makeRpcRequest()` and `parseRpcResponse()` from jsonrpc.ts
 *   - `streamMessage()` sends `SendStreamingMessage` with `Accept: text/event-stream`
 *     and parses `A2AStreamEvent` directly from each SSE `data:` line
 *   - `A2A-Version: 1.0` sent on all requests
 *   - `traceparent` propagated from ExecutionContext for distributed tracing
 *   - Deprecated REST-style method names kept as thin shims
 *
 * In-process bus (`weaveA2ABus`) is unchanged from Phase 1 — it talks directly
 * to `A2AServer.handleMessage()` without HTTP.
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
import {
  A2A_METHODS,
  A2A_ERROR_CODES,
  A2AJsonRpcError,
  makeRpcRequest,
  parseRpcResponse,
} from './jsonrpc.js';
import { parseSseStream } from './sse-parser.js';

const A2A_VERSION_HEADER = 'A2A-Version';
const A2A_VERSION = '1.0';

// ─── W3C Trace Context ────────────────────────────────────────────────────────

/**
 * Build a W3C `traceparent` header value from the execution context.
 * Format: `00-{traceId32hex}-{spanId16hex}-01`
 */
function buildTraceparent(ctx: ExecutionContext): string | undefined {
  const raw = ctx.executionId;
  if (!raw) return undefined;
  // Pad/trim executionId to 32 hex chars (trace-id)
  const traceId = raw.replace(/-/g, '').padEnd(32, '0').slice(0, 32);
  const spanId = (ctx.parentSpanId ?? raw.replace(/-/g, '')).slice(0, 16).padEnd(16, '0');
  return `00-${traceId}-${spanId}-01`;
}

// ─── Base headers ─────────────────────────────────────────────────────────────

function rpcHeaders(ctx: ExecutionContext, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [A2A_VERSION_HEADER]: A2A_VERSION,
    ...extra,
  };
  const traceparent = buildTraceparent(ctx);
  if (traceparent) headers['traceparent'] = traceparent;
  return headers;
}

// ─── Tracing ──────────────────────────────────────────────────────────────────

async function withSpan<T>(
  ctx: ExecutionContext,
  name: string,
  attributes: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = weaveResolveTracer(ctx);
  if (!tracer) return fn();
  return tracer.withSpan(ctx, name, () => fn(), attributes);
}

// ─── JSON-RPC POST helper ─────────────────────────────────────────────────────

async function rpcPost<T>(
  ctx: ExecutionContext,
  agentUrl: string,
  method: string,
  params: unknown,
): Promise<T> {
  const body = JSON.stringify(makeRpcRequest(method, params));
  const response = await withSpan(ctx, `a2a.client.${method}`, { agentUrl, method }, () =>
    a2aFetch(agentUrl, {
      method: 'POST',
      headers: rpcHeaders(ctx),
      body,
      signal: ctx.signal,
    }),
  );
  if (!response.ok) {
    throw new WeaveIntelError({
      code: 'PROTOCOL_ERROR',
      message: `A2A ${method} failed: HTTP ${response.status} ${response.statusText}`,
    });
  }
  const json = await response.json();
  try {
    return parseRpcResponse<T>(json);
  } catch (err) {
    if (err instanceof A2AJsonRpcError) {
      throw new WeaveIntelError({
        code: err.code === A2A_ERROR_CODES.TASK_NOT_FOUND ? 'NOT_FOUND' : 'PROTOCOL_ERROR',
        message: `A2A ${method} error ${err.code}: ${err.message}`,
      });
    }
    throw err;
  }
}

// ─── HTTP-based A2A client (JSON-RPC 2.0) ────────────────────────────────────

export function weaveA2AClient(): A2AClient {
  return {
    // ── Discovery ───────────────────────────────────────────────────────────────

    async discover(url: string): Promise<AgentCard> {
      const base = url.replace(/\/$/, '');
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

      // H-14 origin check: card endpoint must share origin with discovery URL
      const cardEndpointUrl = card.supportedInterfaces?.[0]?.url ?? card.url;
      if (!cardEndpointUrl) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A agent card from ${v1Path} has no "supportedInterfaces[0].url" or "url" field`,
        });
      }

      try {
        const requestedOrigin = new URL(v1Path).origin;
        const cardOrigin = new URL(cardEndpointUrl).origin;
        if (cardOrigin !== requestedOrigin) {
          throw new WeaveIntelError({
            code: 'PROTOCOL_ERROR',
            message: `A2A card URL origin mismatch: card claims "${cardOrigin}" but fetched from "${requestedOrigin}"`,
          });
        }
      } catch (err) {
        if (err instanceof WeaveIntelError) throw err;
        if (!cardEndpointUrl.startsWith('http')) return card; // non-http scheme (tests)
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A agent card endpoint is not a valid URL: ${cardEndpointUrl}`,
        });
      }

      return card;
    },

    // ── v1.0 methods (JSON-RPC 2.0) ─────────────────────────────────────────────

    async sendMessage(ctx: ExecutionContext, agentUrl: string, params: A2ATaskSendParams): Promise<A2ATask> {
      return rpcPost<A2ATask>(ctx, agentUrl, A2A_METHODS.SEND_MESSAGE, params);
    },

    async *streamMessage(ctx: ExecutionContext, agentUrl: string, params: A2ATaskSendParams): AsyncIterable<A2AStreamEvent> {
      const rpcReq = makeRpcRequest(A2A_METHODS.SEND_STREAMING_MESSAGE, params);
      const body = JSON.stringify(rpcReq);

      const response = await withSpan(ctx, 'a2a.client.SendStreamingMessage', { agentUrl }, () =>
        a2aFetchStream(agentUrl, {
          method: 'POST',
          headers: rpcHeaders(ctx, { Accept: 'text/event-stream' }),
          body,
          signal: ctx.signal,
        }),
      );

      if (!response.ok || !response.body) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A SendStreamingMessage failed: HTTP ${response.status}`,
        });
      }

      yield* parseSseStream<A2AStreamEvent>(response.body);
    },

    async getTask(ctx: ExecutionContext, agentUrl: string, taskId: string, historyLength?: number): Promise<A2ATask> {
      const params: Record<string, unknown> = { id: taskId };
      if (historyLength !== undefined) params['historyLength'] = historyLength;
      return rpcPost<A2ATask>(ctx, agentUrl, A2A_METHODS.GET_TASK, params);
    },

    async listTasks(ctx: ExecutionContext, agentUrl: string, filter?: A2AListTasksFilter): Promise<A2ATaskPage> {
      const params: Record<string, unknown> = {};
      if (filter?.contextId) params['contextId'] = filter.contextId;
      if (filter?.state) params['status'] = filter.state; // spec uses "status" in ListTasks params
      if (filter?.pageSize) params['pageSize'] = filter.pageSize;
      if (filter?.pageToken) params['pageToken'] = filter.pageToken;
      if (filter?.statusTimestampAfter) params['statusTimestampAfter'] = filter.statusTimestampAfter;
      return rpcPost<A2ATaskPage>(ctx, agentUrl, A2A_METHODS.LIST_TASKS, params);
    },

    async cancelTask(ctx: ExecutionContext, agentUrl: string, taskId: string): Promise<void> {
      await rpcPost<unknown>(ctx, agentUrl, A2A_METHODS.CANCEL_TASK, { id: taskId });
    },

    async *subscribeToTask(ctx: ExecutionContext, agentUrl: string, taskId: string): AsyncIterable<A2AStreamEvent> {
      const rpcReq = makeRpcRequest(A2A_METHODS.SUBSCRIBE_TO_TASK, { id: taskId });
      const response = await withSpan(ctx, 'a2a.client.SubscribeToTask', { agentUrl, taskId }, () =>
        a2aFetchStream(agentUrl, {
          method: 'POST',
          headers: rpcHeaders(ctx, { Accept: 'text/event-stream' }),
          body: JSON.stringify(rpcReq),
          signal: ctx.signal,
        }),
      );

      if (!response.ok || !response.body) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A SubscribeToTask failed: HTTP ${response.status}`,
        });
      }

      yield* parseSseStream<A2AStreamEvent>(response.body);
    },

    // ── Deprecated v0.3 compat ────────────────────────────────────────────────

    /** @deprecated Use sendMessage(). */
    async sendTask(ctx: ExecutionContext, agentUrl: string, task: A2ATaskLegacy): Promise<A2ATaskResult> {
      const params: A2ATaskSendParams = { message: task.input, metadata: task.metadata };
      const result = await this.sendMessage(ctx, agentUrl, params);
      const outputText = result.artifacts[0]?.parts[0]?.text;
      return {
        id: task.id,
        status: result.status.state === 'TASK_STATE_COMPLETED' ? 'completed' : 'failed',
        output: outputText ? { role: 'agent', parts: [{ text: outputText }] } : undefined,
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

// ─── Internal A2A bus (in-process delegation — unchanged from Phase 1) ────────

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
      if (agent.handleMessage) {
        return agent.handleMessage(ctx, params);
      }
      // Deprecated fallback for handleTask implementations
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
