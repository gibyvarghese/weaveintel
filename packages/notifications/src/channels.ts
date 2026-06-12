/**
 * Notification channel implementations for the weaveIntel platform.
 *
 * All channels:
 *   - accept credentials injected at construction (never fetched from process.env)
 *   - use the hardened fetch from @weaveintel/core for all outbound HTTP
 *   - retry transient failures via @weaveintel/resilience
 *
 * VOCABULARY: platform-layer only — no "chat", "conversation", "message" (HTTP sense
 * of the word) to avoid conflating with framework networking.
 */
// no-raw-fetch: allow (reason: every `fetch` here is the hardened closure destructured
// from createHardenedFetch — a local symbol, not the global fetch)

import { createHardenedFetch, newUUIDv7, type ExecutionContext, type CapabilityId } from '@weaveintel/core';
import type { NotificationChannel, NotificationMessage, ChannelTarget, NotificationDelivery } from '@weaveintel/core';
import { createRetryPolicy, createResilientCallable } from '@weaveintel/resilience';
import { createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

const defaultRetry = createRetryPolicy({ maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 15_000 });

// ---------------------------------------------------------------------------
// Webhook channel
// ---------------------------------------------------------------------------

export interface WebhookChannelOptions {
  /** Channel id — must match ChannelTarget.kind registration key. */
  id?: string;
  /** HMAC-SHA-256 signing secret included as `X-WeaveIntel-Signature` header. */
  signingSecret?: string;
  /** Additional headers injected on every request. */
  headers?: Record<string, string>;
  /** Timeout in ms (default 10 000). */
  timeoutMs?: number;
}

export function createWebhookChannel(opts: WebhookChannelOptions = {}): NotificationChannel {
  const { fetch } = createHardenedFetch({ errorTag: 'notifications:webhook', timeoutMs: opts.timeoutMs ?? 10_000 });
  const id = opts.id ?? 'webhook';

  const doSend = createResilientCallable(
    async (body: string, url: string) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...opts.headers,
      };
      if (opts.signingSecret) {
        const sig = createHmac('sha256', opts.signingSecret).update(body).digest('hex');
        headers['X-WeaveIntel-Signature'] = `sha256=${sig}`;
      }
      const resp = await fetch(url, { method: 'POST', headers, body });
      if (!resp.ok) throw new Error(`webhook returned HTTP ${resp.status}`);
    },
    { endpoint: 'notifications:webhook:send', retry: defaultRetry },
  );

  return {
    id,
    capabilities: new Set<CapabilityId>(),
    async send(_ctx: ExecutionContext, msg: NotificationMessage, target: ChannelTarget): Promise<NotificationDelivery> {
      const body = JSON.stringify({ id: msg.id, category: msg.category, title: msg.title, body: msg.body, data: msg.data });
      try {
        await doSend(body, target.address);
        return { channelId: id, messageId: newUUIDv7(), status: 'sent' };
      } catch (err) {
        return { channelId: id, messageId: newUUIDv7(), status: 'failed', detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Web Push channel
// ---------------------------------------------------------------------------

export interface WebPushChannelOptions {
  id?: string;
  /** VAPID Authorization header value (caller manages token refresh). */
  vapidAuthorization: string;
  timeoutMs?: number;
}

export function createWebPushChannel(opts: WebPushChannelOptions): NotificationChannel {
  const { fetch } = createHardenedFetch({ errorTag: 'notifications:web-push', timeoutMs: opts.timeoutMs ?? 10_000 });
  const id = opts.id ?? 'web-push';

  const doSend = createResilientCallable(
    async (payload: string, endpoint: string, auth: string) => {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': auth,
          'TTL': '86400',
        },
        body: payload,
      });
      if (!resp.ok && resp.status !== 201) throw new Error(`web-push returned HTTP ${resp.status}`);
    },
    { endpoint: 'notifications:web-push:send', retry: defaultRetry },
  );

  return {
    id,
    capabilities: new Set<CapabilityId>(),
    async send(_ctx: ExecutionContext, msg: NotificationMessage, target: ChannelTarget): Promise<NotificationDelivery> {
      const payload = JSON.stringify({ title: msg.title, body: msg.body, data: msg.data });
      try {
        await doSend(payload, target.address, opts.vapidAuthorization);
        return { channelId: id, messageId: newUUIDv7(), status: 'sent' };
      } catch (err) {
        return { channelId: id, messageId: newUUIDv7(), status: 'failed', detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// APNs channel  (HTTP/2 endpoint via fetch; JWT signed by caller)
// ---------------------------------------------------------------------------

export interface ApnsChannelOptions {
  id?: string;
  /** APNs bundle ID (app ID). */
  bundleId: string;
  /** Pre-signed Bearer token — caller rotates this before each send if expired. */
  bearerToken: string;
  /** APNs host. Defaults to api.push.apple.com. Use api.sandbox.push.apple.com for dev. */
  host?: string;
  timeoutMs?: number;
}

export function createApnsChannel(opts: ApnsChannelOptions): NotificationChannel {
  const host = opts.host ?? 'api.push.apple.com';
  const { fetch } = createHardenedFetch({ errorTag: 'notifications:apns', timeoutMs: opts.timeoutMs ?? 15_000 });
  const id = opts.id ?? 'apns';

  const doSend = createResilientCallable(
    async (payload: string, deviceToken: string, bearerToken: string) => {
      const url = `https://${host}/3/device/${deviceToken}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `bearer ${bearerToken}`,
          'apns-topic': opts.bundleId,
          'apns-push-type': 'alert',
        },
        body: payload,
      });
      if (!resp.ok) throw new Error(`apns returned HTTP ${resp.status}`);
    },
    { endpoint: 'notifications:apns:send', retry: defaultRetry },
  );

  return {
    id,
    capabilities: new Set<CapabilityId>(),
    async send(_ctx: ExecutionContext, msg: NotificationMessage, target: ChannelTarget): Promise<NotificationDelivery> {
      const payload = JSON.stringify({ aps: { alert: { title: msg.title, body: msg.body }, sound: 'default' }, data: msg.data ?? {} });
      try {
        await doSend(payload, target.address, opts.bearerToken);
        return { channelId: id, messageId: newUUIDv7(), status: 'sent' };
      } catch (err) {
        return { channelId: id, messageId: newUUIDv7(), status: 'failed', detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// FCM channel  (HTTP v1 API)
// ---------------------------------------------------------------------------

export interface FcmChannelOptions {
  id?: string;
  /** Google Cloud project ID. */
  projectId: string;
  /** OAuth 2.0 access token — caller manages rotation. */
  accessToken: string;
  timeoutMs?: number;
}

export function createFcmChannel(opts: FcmChannelOptions): NotificationChannel {
  const url = `https://fcm.googleapis.com/v1/projects/${opts.projectId}/messages:send`;
  const { fetch } = createHardenedFetch({ errorTag: 'notifications:fcm', timeoutMs: opts.timeoutMs ?? 15_000 });
  const id = opts.id ?? 'fcm';

  const doSend = createResilientCallable(
    async (body: string, accessToken: string) => {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body,
      });
      if (!resp.ok) throw new Error(`fcm returned HTTP ${resp.status}`);
    },
    { endpoint: 'notifications:fcm:send', retry: defaultRetry },
  );

  return {
    id,
    capabilities: new Set<CapabilityId>(),
    async send(_ctx: ExecutionContext, msg: NotificationMessage, target: ChannelTarget): Promise<NotificationDelivery> {
      const body = JSON.stringify({
        message: {
          token: target.address,
          notification: { title: msg.title, body: msg.body },
          data: msg.data ? Object.fromEntries(Object.entries(msg.data).map(([k, v]) => [k, String(v)])) : {},
        },
      });
      try {
        await doSend(body, opts.accessToken);
        return { channelId: id, messageId: newUUIDv7(), status: 'sent' };
      } catch (err) {
        return { channelId: id, messageId: newUUIDv7(), status: 'failed', detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
