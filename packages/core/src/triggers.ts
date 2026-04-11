/**
 * @weaveintel/core — Event trigger contracts
 */

// ─── Trigger Definition ──────────────────────────────────────

export type TriggerType = 'cron' | 'webhook' | 'queue' | 'change' | 'event' | 'manual';

export interface TriggerDefinition {
  id: string;
  name: string;
  description?: string;
  type: TriggerType;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

// ─── Event Trigger ───────────────────────────────────────────

export interface EventTrigger {
  id: string;
  definitionId: string;
  eventType: string;
  filter?: Record<string, unknown>;
  handler: string;
  enabled: boolean;
}

// ─── Subscription ────────────────────────────────────────────

export interface TriggerSubscription {
  id: string;
  triggerId: string;
  workflowId?: string;
  agentId?: string;
  createdAt: string;
}

// ─── Envelope ────────────────────────────────────────────────

export interface EventEnvelope {
  id: string;
  type: string;
  source: string;
  timestamp: string;
  data: unknown;
  metadata?: Record<string, unknown>;
}

// ─── Handler ─────────────────────────────────────────────────

export interface TriggerHandler {
  handle(event: EventEnvelope): Promise<void>;
}

// ─── Workflow Binding ────────────────────────────────────────

export interface EventDrivenWorkflowBinding {
  id: string;
  triggerId: string;
  workflowId: string;
  inputMapping?: Record<string, string>;
  enabled: boolean;
}
