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
      const response = await fetch(wellKnown);
      if (!response.ok) {
        throw new WeaveIntelError({
          code: 'PROTOCOL_ERROR',
          message: `A2A discovery failed at ${wellKnown}: ${response.status}`,
        });
      }
      return response.json() as Promise<AgentCard>;
    },

    async sendTask(ctx: ExecutionContext, agentUrl: string, task: A2ATask): Promise<A2ATaskResult> {
      const taskUrl = agentUrl.replace(/\/$/, '') + '/tasks';
      const response = await withObservedSpan(
        ctx,
        'a2a.client.send_task',
        { agentUrl, taskId: task.id },
        () => fetch(taskUrl, {
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
      const response = await withObservedSpan(
        ctx,
        'a2a.client.stream_task',
        { agentUrl, taskId: task.id },
        () => fetch(taskUrl, {
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
      await withObservedSpan(
        ctx,
        'a2a.client.cancel_task',
        { agentUrl, taskId },
        () => fetch(url, { method: 'POST', signal: ctx.signal }).then(() => undefined),
      );
    },

    async getTaskStatus(ctx: ExecutionContext, agentUrl: string, taskId: string): Promise<A2ATaskResult> {
      const url = agentUrl.replace(/\/$/, '') + `/tasks/${encodeURIComponent(taskId)}`;
      const response = await withObservedSpan(
        ctx,
        'a2a.client.get_status',
        { agentUrl, taskId },
        () => fetch(url, { signal: ctx.signal }),
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
