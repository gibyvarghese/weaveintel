/**
 * GeneWeave chat — trace span helpers
 *
 * Extracted from ChatEngine to keep chat.ts focused on orchestration.
 */

import { randomUUID, createHash } from 'node:crypto';
import type { AgentStep, CapabilityTelemetrySummary, EventBus } from '@weaveintel/core';
import { EventTypes } from '@weaveintel/core';
import {
  capabilityTelemetryToEvent,
  capabilityTelemetryToSpanAttributes,
} from '@weaveintel/observability';
import type { DatabaseAdapter } from './db.js';

// ── Types ───────────────────────────────────────────────────

export interface ToolCallObservableEvent {
  phase: 'start' | 'end' | 'error';
  timestamp: number;
  executionId?: string;
  spanId?: string;
  data: Record<string, unknown>;
}

export interface AgentRunTelemetry {
  result: import('@weaveintel/core').AgentResult;
  toolCallEvents: ToolCallObservableEvent[];
  systemPromptSha256?: string;
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Compute SHA256 fingerprint of a system prompt.
 * Used for forensic verification that a specific prompt was included in LLM call.
 */
export function computePromptFingerprint(prompt?: string): string {
  if (!prompt) return '';
  return createHash('sha256').update(prompt).digest('hex');
}

export function observeToolCallEvents(eventBus: EventBus): { events: ToolCallObservableEvent[]; dispose: () => void } {
  const events: ToolCallObservableEvent[] = [];
  const unsubscribers: Array<() => void> = [];

  unsubscribers.push(eventBus.on(EventTypes.ToolCallStart, (event) => {
    events.push({
      phase: 'start',
      timestamp: event.timestamp,
      executionId: event.executionId,
      spanId: event.spanId,
      data: event.data,
    });
  }));

  unsubscribers.push(eventBus.on(EventTypes.ToolCallEnd, (event) => {
    events.push({
      phase: 'end',
      timestamp: event.timestamp,
      executionId: event.executionId,
      spanId: event.spanId,
      data: event.data,
    });
  }));

  unsubscribers.push(eventBus.on(EventTypes.ToolCallError, (event) => {
    events.push({
      phase: 'error',
      timestamp: event.timestamp,
      executionId: event.executionId,
      spanId: event.spanId,
      data: event.data,
    });
  }));

  return {
    events,
    dispose: () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  };
}

export async function recordTraceSpans(
  db: DatabaseAdapter,
  userId: string,
  chatId: string,
  messageId: string,
  traceId: string,
  mode: string,
  startMs: number,
  latencyMs: number,
  steps?: AgentStep[],
  toolCallEvents?: ToolCallObservableEvent[],
  capabilities?: CapabilityTelemetrySummary[],
  systemPromptSha256?: string,
): Promise<void> {
  try {
    // Root span
    const rootSpanId = randomUUID();
    const rootAttributes: Record<string, unknown> = {
      mode,
      capabilityCount: capabilities?.length ?? 0,
      capabilities: capabilities?.map((entry) => ({ kind: entry.kind, key: entry.key, name: entry.name })),
    };
    if (systemPromptSha256) {
      rootAttributes['systemPromptFingerprint'] = systemPromptSha256;
    }
    await db.saveTrace({
      id: randomUUID(), userId, chatId, messageId,
      traceId, spanId: rootSpanId,
      name: `chat.${mode}`,
      startTime: startMs, endTime: startMs + latencyMs,
      status: 'ok',
      attributes: JSON.stringify(rootAttributes),
    });

    // Child spans for agent steps
    if (steps) {
      let offset = startMs;
      for (const step of steps) {
        await db.saveTrace({
          id: randomUUID(), userId, chatId, messageId,
          traceId, spanId: randomUUID(), parentSpanId: rootSpanId,
          name: `step.${step.type}${step.toolCall ? `.${step.toolCall.name}` : ''}`,
          startTime: offset, endTime: offset + step.durationMs,
          status: 'ok',
          attributes: JSON.stringify({
            stepIndex: step.index,
            type: step.type,
            toolCall: step.toolCall,
            delegation: step.delegation,
            tokenUsage: step.tokenUsage,
          }),
        });
        offset += step.durationMs;
      }
    }

    if (toolCallEvents?.length) {
      const starts = new Map<string, ToolCallObservableEvent[]>();
      const pending: ToolCallObservableEvent[] = [];

      const keyFor = (event: ToolCallObservableEvent, toolName: string): string =>
        `${event.executionId ?? ''}|${event.spanId ?? ''}|${toolName}`;

      const toolNameFor = (event: ToolCallObservableEvent): string => {
        const fromData = event.data['tool'];
        if (typeof fromData === 'string' && fromData.trim()) return fromData;
        const fromName = event.data['name'];
        if (typeof fromName === 'string' && fromName.trim()) return fromName;
        return 'unknown';
      };

      for (const event of toolCallEvents) {
        const toolName = toolNameFor(event);
        const key = keyFor(event, toolName);
        if (event.phase === 'start') {
          const arr = starts.get(key) ?? [];
          arr.push(event);
          starts.set(key, arr);
          continue;
        }

        const arr = starts.get(key);
        const start = arr?.shift();
        if (arr && arr.length === 0) starts.delete(key);

        const spanStart = start?.timestamp ?? event.timestamp;
        const spanEnd = Math.max(event.timestamp, spanStart + 1);
        pending.push({
          ...event,
          timestamp: spanEnd,
          data: {
            ...event.data,
            _toolName: toolName,
            _startTime: spanStart,
          },
        });
      }

      for (const event of pending) {
        const toolName = (typeof event.data['_toolName'] === 'string' && event.data['_toolName']) ? event.data['_toolName'] as string : 'unknown';
        const spanStart = typeof event.data['_startTime'] === 'number' ? event.data['_startTime'] as number : event.timestamp;
        const status = event.phase === 'error' ? 'error' : 'ok';
        const attributes = { ...event.data };
        delete (attributes as Record<string, unknown>)['_toolName'];
        delete (attributes as Record<string, unknown>)['_startTime'];

        await db.saveTrace({
          id: randomUUID(), userId, chatId, messageId,
          traceId,
          spanId: event.spanId ?? randomUUID(),
          parentSpanId: rootSpanId,
          name: `tool_call.${toolName}`,
          startTime: spanStart,
          endTime: event.timestamp,
          status,
          attributes: JSON.stringify({
            phase: event.phase,
            executionId: event.executionId,
            tool: toolName,
            data: attributes,
          }),
        });
      }
    }

    if (capabilities?.length) {
      for (const capability of capabilities) {
        const attributes = capabilityTelemetryToSpanAttributes(capability);
        const event = capabilityTelemetryToEvent(capability, 'success');
        await db.saveTrace({
          id: randomUUID(), userId, chatId, messageId,
          traceId,
          spanId: randomUUID(),
          parentSpanId: rootSpanId,
          name: `capability.${capability.kind}.${capability.key}`,
          startTime: startMs,
          endTime: startMs + Math.max(1, capability.durationMs ?? latencyMs),
          status: 'ok',
          attributes: JSON.stringify(attributes),
          events: JSON.stringify([event]),
        });
      }
    }
  } catch {
    // Trace recording is best-effort
  }
}
