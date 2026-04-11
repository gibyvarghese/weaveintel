/**
 * @weaveintel/ui-primitives — UiEvent & StreamEnvelope builders
 *
 * Fluent helpers to create type-safe UI events and wrap them in
 * sequenced stream envelopes.
 */

import { randomUUID } from 'node:crypto';
import type { UiEvent, UiEventType, StreamEnvelope } from '@weaveintel/core';

// ─── UiEvent builders ────────────────────────────────────────

export function createUiEvent(type: UiEventType, data: unknown): UiEvent {
  return {
    type,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    data,
  };
}

export function textEvent(text: string): UiEvent {
  return createUiEvent('text', { text });
}

export function errorEvent(message: string, code?: string): UiEvent {
  return createUiEvent('error', { message, code });
}

export function statusEvent(status: string, details?: string): UiEvent {
  return createUiEvent('status', { status, details });
}

export function toolCallEvent(
  toolName: string,
  args: Record<string, unknown>,
  result?: unknown,
): UiEvent {
  return createUiEvent('tool-call', { toolName, args, result });
}

export function stepUpdateEvent(
  stepId: string,
  label: string,
  status: 'running' | 'completed' | 'failed',
  details?: string,
): UiEvent {
  return createUiEvent('step-update', { stepId, label, status, details });
}

// ─── StreamEnvelope builder ──────────────────────────────────

let _seq = 0;

/** Reset the global sequence counter (useful for tests). */
export function resetSequence(): void {
  _seq = 0;
}

/**
 * Wrap a UiEvent in a StreamEnvelope with an auto-incrementing sequence.
 */
export function envelope(
  event: UiEvent,
  opts?: { sessionId?: string; agentId?: string },
): StreamEnvelope {
  return {
    event,
    sequence: ++_seq,
    sessionId: opts?.sessionId,
    agentId: opts?.agentId,
  };
}

/**
 * Stateful envelope factory bound to a specific session/agent.
 * Maintains its own independent sequence counter.
 */
export function createStreamBuilder(opts?: {
  sessionId?: string;
  agentId?: string;
}): StreamBuilder {
  let seq = 0;
  return {
    send(type: UiEventType, data: unknown): StreamEnvelope {
      const event = createUiEvent(type, data);
      return { event, sequence: ++seq, sessionId: opts?.sessionId, agentId: opts?.agentId };
    },
    text(text: string): StreamEnvelope {
      return this.send('text', { text });
    },
    error(message: string, code?: string): StreamEnvelope {
      return this.send('error', { message, code });
    },
    status(status: string, details?: string): StreamEnvelope {
      return this.send('status', { status, details });
    },
    get sequence(): number {
      return seq;
    },
  };
}

export interface StreamBuilder {
  send(type: UiEventType, data: unknown): StreamEnvelope;
  text(text: string): StreamEnvelope;
  error(message: string, code?: string): StreamEnvelope;
  status(status: string, details?: string): StreamEnvelope;
  readonly sequence: number;
}
