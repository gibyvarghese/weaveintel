/**
 * @weaveintel/ui-primitives — Inbound widget action events
 *
 * Formalises the "user interacted with a widget" pattern as a typed
 * `UiEvent`.  Clients build these via `widgetActionEvent`; the server
 * validates inbound payloads with `parseWidgetAction`.
 *
 * Vocabulary rule: "widget action" / "interaction" — never "message" or "turn".
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { UiEvent } from '@weaveintel/core';

// ─── Action payload ───────────────────────────────────────────────────────────

export interface WidgetActionPayload {
  /** Id of the widget the user interacted with. */
  readonly widgetId: string;
  /** Id of the action button / control that was activated. */
  readonly actionId: string;
  /** Optional value (e.g. form field contents, selected option). */
  readonly value?: unknown;
}

// ─── Builder ──────────────────────────────────────────────────────────────────

/**
 * Build a `UiEvent` that represents a user interaction with a widget.
 *
 * Clients call this when a user taps an action button, submits a form, or
 * otherwise interacts with a widget.  The event is posted to the server via
 * `POST /api/me/runs/:id/events` (or `runClient.postEvent`).
 */
export function widgetActionEvent(
  widgetId: string,
  actionId: string,
  value?: unknown,
): UiEvent {
  const payload: WidgetActionPayload = {
    widgetId,
    actionId,
    ...(value !== undefined ? { value } : {}),
  };
  return {
    type: 'widget',
    id: newUUIDv7(),
    timestamp: new Date().toISOString(),
    data: payload,
  };
}

// ─── Server-side validator ────────────────────────────────────────────────────

export interface ParseWidgetActionResult {
  ok: true;
  payload: WidgetActionPayload;
}
export interface ParseWidgetActionError {
  ok: false;
  reason: string;
}
export type ParseWidgetActionOutcome = ParseWidgetActionResult | ParseWidgetActionError;

/**
 * Validate and extract a `WidgetActionPayload` from an inbound `UiEvent`.
 *
 * Returns `{ ok: true, payload }` on success, `{ ok: false, reason }` on
 * validation failure.  Callers should return HTTP 400 on failure.
 */
export function parseWidgetAction(event: UiEvent): ParseWidgetActionOutcome {
  if (event.type !== 'widget') {
    return { ok: false, reason: `Expected event.type 'widget', got '${event.type}'` };
  }
  const raw = event.data as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'event.data must be an object' };
  }
  if (typeof raw['widgetId'] !== 'string' || !raw['widgetId']) {
    return { ok: false, reason: 'event.data.widgetId must be a non-empty string' };
  }
  if (typeof raw['actionId'] !== 'string' || !raw['actionId']) {
    return { ok: false, reason: 'event.data.actionId must be a non-empty string' };
  }
  return {
    ok: true,
    payload: {
      widgetId: raw['widgetId'],
      actionId: raw['actionId'],
      ...(raw['value'] !== undefined ? { value: raw['value'] } : {}),
    },
  };
}
