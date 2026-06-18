/**
 * @weaveintel/a2a — Agent-to-Agent protocol implementation
 *
 * Provides an A2A client for remote agent communication and an internal
 * A2A bus for in-process agent-to-agent delegation. Based on the Google
 * A2A protocol concepts.
 */

import type {
  A2AClient,
  A2AServer,
  A2ATask,
  A2ATaskResult,
  AgentCard,
  InternalA2ABus,
  ExecutionContext,
} from '@weaveintel/core';
import { weaveContext, WeaveIntelError, weaveResolveTracer } from '@weaveintel/core';
import { a2aFetch, a2aFetchStream } from './_fetch.js';

async function withObservedSpan<T>(
  ctx: ExecutionContext,
  name: string,
  attributes: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = weaveResolveTracer(ctx);
  if (!tracer) {
    return fn();
  }
  return tracer.withSpan(ctx, name, () => fn(), attributes);
}

// ─── HTTP-based A2A client ───────────────────────────────────

export function weaveA2AClient(): A2AClient {
  return {
    async discover(url: string): Promise<AgentCard> {
      const wellKnown = url.replace(/\/$/, '') + '/.well-known/agent.json';
      const response = await a2aFetch(wellKnown);
      if (!response.ok) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A discovery failed at ${wellKnown}: ${response.status}`,
        });
      }
      const card = await response.json() as AgentCard;

      // H-14: Validate the fetched agent card so a malicious or misconfigured
      // server cannot inject an arbitrary agent card that silently redirects
      // subsequent task calls to a different origin.
      //
      // Checks:
      //  1. `name` is a non-empty string (primary identifier in the A2A spec).
      //  2. `url` is a non-empty string (used to route all subsequent requests).
      //  3. `card.url` shares the same origin as the discovery URL — prevents a
      //     card fetched from host-A from claiming its tasks endpoint is on host-B.
      if (!card || typeof card.name !== 'string' || !card.name) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A agent card from ${wellKnown} is missing a valid "name" field`,
        });
      }
      if (typeof card.url !== 'string' || !card.url) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A agent card from ${wellKnown} is missing a valid "url" field`,
        });
      }
      // Origin check: parse both URLs and compare scheme + host + port.
      try {
        const requestedOrigin = new URL(wellKnown).origin;
        const cardOrigin = new URL(card.url).origin;
        if (cardOrigin !== requestedOrigin) {
          throw new WeaveIntelError({
            code: 'PROTOCOL_ERROR',
            message: `A2A agent card URL origin mismatch: card claims "${cardOrigin}" but was fetched from "${requestedOrigin}". Possible open-redirect or SSRF.`,
          });
        }
      } catch (err) {
        // Re-throw WeaveIntelError as-is; URL parse errors also become a protocol error.
        if (err instanceof WeaveIntelError) throw err;
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A agent card url is not a valid URL: ${card.url}`,
        });
      }

      return card;
    },

    async sendTask(ctx: ExecutionContext, agentUrl: string, task: A2ATask): Promise<A2ATaskResult> {
      const taskUrl = agentUrl.replace(/\/$/, '') + '/tasks';
      const response = await withObservedSpan(
        ctx,
        'a2a.client.send_task',
        { agentUrl, taskId: task.id },
        () => a2aFetch(taskUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(task),
          signal: ctx.signal,
        }),
      );
      if (!response.ok) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A task failed: ${response.status} ${response.statusText}`,
        });
      }
      return response.json() as Promise<A2ATaskResult>;
    },

    async *streamTask(ctx: ExecutionContext, agentUrl: string, task: A2ATask): AsyncIterable<A2ATaskResult> {
      const taskUrl = agentUrl.replace(/\/$/, '') + '/tasks/stream';
      // SSE streams are inherently long-running: enforce HTTPS only, skip
      // request-level timeout + size cap (would kill a healthy stream).
      const response = await withObservedSpan(
        ctx,
        'a2a.client.stream_task',
        { agentUrl, taskId: task.id },
        () => a2aFetchStream(taskUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(task),
          signal: ctx.signal,
        }),
      );
      if (!response.ok || !response.body) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A stream failed: ${response.status}`,
        });
      }

      const reader = response.body.getReader();
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
              if (data && data !== '[DONE]') {
                yield JSON.parse(data) as A2ATaskResult;
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    },

    async cancelTask(ctx: ExecutionContext, agentUrl: string, taskId: string): Promise<void> {
      const url = agentUrl.replace(/\/$/, '') + `/tasks/${encodeURIComponent(taskId)}/cancel`;
      // L-13: Previously the response status was ignored — a 404 or 500 from
      // the remote would be silently swallowed as a successful cancellation.
      // Now we check response.ok and throw on non-2xx so callers know when
      // the cancellation was not honoured by the remote agent.
      const response = await withObservedSpan(
        ctx,
        'a2a.client.cancel_task',
        { agentUrl, taskId },
        () => a2aFetch(url, { method: 'POST', signal: ctx.signal }),
      );
      if (!response.ok) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A cancelTask failed for task "${taskId}": ${response.status} ${response.statusText}`,
        });
      }
    },

    async getTaskStatus(ctx: ExecutionContext, agentUrl: string, taskId: string): Promise<A2ATaskResult> {
      const url = agentUrl.replace(/\/$/, '') + `/tasks/${encodeURIComponent(taskId)}`;
      const response = await withObservedSpan(
        ctx,
        'a2a.client.get_status',
        { agentUrl, taskId },
        () => a2aFetch(url, { signal: ctx.signal }),
      );
      if (!response.ok) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A status check failed: ${response.status}`,
        });
      }
      return response.json() as Promise<A2ATaskResult>;
    },
  };
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

    async send(ctx: ExecutionContext, target: string, task: A2ATask): Promise<A2ATaskResult> {
      const agent = agents.get(target);
      if (!agent) {
        throw new WeaveIntelError({
          code: 'NOT_FOUND',
          message: `A2A agent not found: ${target}. Available: ${[...agents.keys()].join(', ')}`,
        });
      }
      return agent.handleTask(ctx, task);
    },

    discover(name: string): AgentCard | undefined {
      return agents.get(name)?.card;
    },

    listAgents(): AgentCard[] {
      return [...agents.values()].map((a) => a.card);
    },
  };
}
