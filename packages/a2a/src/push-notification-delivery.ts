/**
 * @weaveintel/a2a — Push Notification Delivery
 *
 * Delivers A2ATask state updates to registered webhook endpoints after each
 * task state transition. Supports HMAC-SHA256 payload signing and retry.
 *
 * Delivery wire format:
 *   POST {config.url}
 *   Content-Type: application/json
 *   A2A-Version: 1.0
 *   X-A2A-Webhook-Signature: sha256=<hmac-hex>  (when config.token is set)
 *   Authorization: Bearer <token>                (when config.authentication.credentials set)
 *
 *   Body: { task: A2ATask, timestamp: ISO-8601 }
 *
 * Safety:
 *   - The config goes through `validatePushNotificationConfig` (push-guard.ts) before every delivery: https
 *     only, the allow list when one is given, and the core outbound guard (every resolved address public;
 *     private, loopback, link-local and metadata refused). Loopback is refused unless the caller's policy
 *     allows it (a local test receiver).
 *   - The connection is pinned to the checked address, and a redirect is never followed.
 *   - Retry: 3 retries, 1 s / 2 s / 4 s backoff (configurable)
 *   - Non-blocking: delivery errors are logged, never surfaced to task callers
 *
 * Usage:
 *   // After saving a terminal task:
 *   await deliverPushNotificationsForTask(pushStore, task);
 *   // OR fire-and-forget:
 *   void deliverPushNotificationsForTask(pushStore, task).catch(() => {});
 */

import type { A2ATask, A2APushNotificationConfigEntry } from '@weaveintel/core';
import type { A2APushNotificationStore } from './push-notification-store.js';
import { a2aPushFetch } from './_fetch.js';
import { validatePushNotificationConfig, type A2APushPolicy } from './push-guard.js';

// ─── Delivery payload ─────────────────────────────────────────────────────────

export interface PushDeliveryPayload {
  readonly task: A2ATask;
  readonly timestamp: string;
}

// ─── HMAC-SHA256 signing ──────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256 signature of a body string using a secret token.
 * Returns hex-encoded signature. Uses Node.js `crypto` module.
 */
async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const { createHmac } = await import('node:crypto');
  return createHmac('sha256', secret).update(body).digest('hex');
}

// ─── Single delivery attempt ──────────────────────────────────────────────────

async function attemptDelivery(
  config: A2APushNotificationConfigEntry,
  body: string,
  signature: string | null,
  policy: A2APushPolicy,
): Promise<{ ok: boolean; status?: number; error?: string; final?: boolean }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'A2A-Version': '1.0',
  };

  if (signature) {
    headers['X-A2A-Webhook-Signature'] = `sha256=${signature}`;
  }

  // Bearer credential-based auth (separate from HMAC signing token)
  const credentials = config.authentication?.credentials;
  if (credentials) {
    headers['Authorization'] = `Bearer ${credentials}`;
  }

  try {
    const resp = await a2aPushFetch(config.url, { method: 'POST', headers, body }, policy.outbound ?? {});
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    if (resp.status >= 300 && resp.status < 400) {
      return { ok: false, status: resp.status, error: `HTTP ${resp.status} redirect refused (pushes never follow a redirect)`, final: true };
    }
    return { ok: resp.ok, status: resp.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Delivery with retry ──────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

export interface PushDeliveryOptions {
  /** The push policy (allow list, outbound guard settings). Default: no allow list, loopback refused. */
  readonly policy?: A2APushPolicy;
  /** Delays between attempts; its length is the number of retries. Default 1 s, 2 s, 4 s. */
  readonly retryDelaysMs?: readonly number[];
}

export async function deliverToWebhook(
  config: A2APushNotificationConfigEntry,
  payload: PushDeliveryPayload,
  opts: PushDeliveryOptions = {},
): Promise<{ delivered: boolean; attempts: number; lastError?: string }> {
  const policy = opts.policy ?? {};
  const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  // SSRF guard — the same checks as at creation: allow list, https, every resolved address public
  try {
    await validatePushNotificationConfig(config, policy);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { delivered: false, attempts: 0, lastError: `SSRF guard blocked URL: ${reason}` };
  }

  const body = JSON.stringify(payload);

  // Pre-compute HMAC-SHA256 signature whenever a token is present
  let signature: string | null = null;
  if (config.token) {
    try {
      signature = await hmacSha256Hex(config.token, body);
    } catch {
      // signature is best-effort
    }
  }

  let lastError: string | undefined;
  let attempts = 0;
  for (let attempt = 0; attempt < delays.length + 1; attempt++) {
    attempts = attempt + 1;
    const result = await attemptDelivery(config, body, signature, policy);
    if (result.ok) {
      return { delivered: true, attempts };
    }
    lastError = result.error ?? `HTTP ${result.status}`;
    if (result.final) break;
    if (attempt < delays.length) {
      await new Promise<void>((r) => setTimeout(r, delays[attempt]));
    }
  }
  return { delivered: false, attempts, ...(lastError !== undefined ? { lastError } : {}) };
}

// ─── High-level: deliver to all registered configs for a task ─────────────────

/**
 * Look up all push notification configs registered for the given task and
 * fire deliveries to each webhook. All deliveries run concurrently but
 * non-blocking — errors are swallowed (delivery is best-effort per spec).
 *
 * This is the entry point called after any task state transition.
 */
export async function deliverPushNotificationsForTask(
  pushStore: A2APushNotificationStore,
  task: A2ATask,
  opts: PushDeliveryOptions = {},
): Promise<void> {
  let configs: readonly A2APushNotificationConfigEntry[];
  try {
    configs = await pushStore.list(task.id);
  } catch {
    return; // store read failure → silent
  }

  if (configs.length === 0) return;

  const payload: PushDeliveryPayload = {
    task,
    timestamp: new Date().toISOString(),
  };

  // Fire all deliveries concurrently — errors are caught individually
  await Promise.allSettled(
    configs.map((config) =>
      deliverToWebhook(config, payload, opts).catch(() => {}),
    ),
  );
}
