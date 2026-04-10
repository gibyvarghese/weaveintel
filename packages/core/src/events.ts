/**
 * @weaveintel/core — Event system
 *
 * Why: Decoupled telemetry and observability. Every subsystem emits events.
 * Consumers subscribe to what they care about. No subsystem needs to know
 * who's listening. This powers traces, cost tracking, audit logs, etc.
 */

export interface WeaveEvent {
  readonly type: string;
  readonly timestamp: number;
  readonly executionId?: string;
  readonly spanId?: string;
  readonly tenantId?: string;
  readonly data: Record<string, unknown>;
}

export type EventHandler = (event: WeaveEvent) => void | Promise<void>;
export type EventFilter = (event: WeaveEvent) => boolean;

export interface EventBus {
  emit(event: WeaveEvent): void;
  on(type: string, handler: EventHandler): Unsubscribe;
  onAll(handler: EventHandler): Unsubscribe;
  onMatch(filter: EventFilter, handler: EventHandler): Unsubscribe;
}

export type Unsubscribe = () => void;

/** Standard event types */
export const EventTypes = {
  // Model events
  ModelRequestStart: 'model.request.start',
  ModelRequestEnd: 'model.request.end',
  ModelRequestError: 'model.request.error',
  ModelStreamChunk: 'model.stream.chunk',
  ModelTokenUsage: 'model.token.usage',

  // Tool events
  ToolCallStart: 'tool.call.start',
  ToolCallEnd: 'tool.call.end',
  ToolCallError: 'tool.call.error',

  // Agent events
  AgentRunStart: 'agent.run.start',
  AgentRunEnd: 'agent.run.end',
  AgentStepStart: 'agent.step.start',
  AgentStepEnd: 'agent.step.end',
  AgentDelegation: 'agent.delegation',

  // Retrieval events
  RetrieverQueryStart: 'retriever.query.start',
  RetrieverQueryEnd: 'retriever.query.end',
  IndexingStart: 'indexing.start',
  IndexingEnd: 'indexing.end',

  // Memory events
  MemoryRead: 'memory.read',
  MemoryWrite: 'memory.write',

  // Security events
  RedactionApplied: 'redaction.applied',
  PolicyDecision: 'policy.decision',
  AuditEntry: 'audit.entry',

  // Connector events
  ConnectorSyncStart: 'connector.sync.start',
  ConnectorSyncEnd: 'connector.sync.end',
} as const;

/** In-memory event bus implementation */
export function createEventBus(): EventBus {
  const typeHandlers = new Map<string, Set<EventHandler>>();
  const allHandlers = new Set<EventHandler>();
  const filterHandlers = new Map<EventFilter, EventHandler>();

  return {
    emit(event: WeaveEvent): void {
      // Type-specific handlers
      const handlers = typeHandlers.get(event.type);
      if (handlers) {
        for (const h of handlers) {
          try {
            void h(event);
          } catch {
            // Event handlers must not break the emitter
          }
        }
      }
      // Wildcard handlers
      for (const h of allHandlers) {
        try {
          void h(event);
        } catch {
          // swallow
        }
      }
      // Filter handlers
      for (const [filter, handler] of filterHandlers) {
        try {
          if (filter(event)) void handler(event);
        } catch {
          // swallow
        }
      }
    },

    on(type: string, handler: EventHandler): Unsubscribe {
      if (!typeHandlers.has(type)) typeHandlers.set(type, new Set());
      typeHandlers.get(type)!.add(handler);
      return () => typeHandlers.get(type)?.delete(handler);
    },

    onAll(handler: EventHandler): Unsubscribe {
      allHandlers.add(handler);
      return () => allHandlers.delete(handler);
    },

    onMatch(filter: EventFilter, handler: EventHandler): Unsubscribe {
      filterHandlers.set(filter, handler);
      return () => filterHandlers.delete(filter);
    },
  };
}

/** Helper to create a typed event */
export function createEvent(
  type: string,
  data: Record<string, unknown>,
  ctx?: { executionId?: string; spanId?: string; tenantId?: string },
): WeaveEvent {
  return {
    type,
    timestamp: Date.now(),
    executionId: ctx?.executionId,
    spanId: ctx?.spanId,
    tenantId: ctx?.tenantId,
    data,
  };
}
