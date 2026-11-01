/**
 * Email, SMS and Microsoft Teams channels (GAPS G-WI-17).
 *
 * Each channel is a thin adapter over a *transport* interface the host supplies, so the library
 * carries no vendor SDK and no credentials:
 *
 *   - `EmailTransport` — SMTP relay, SES, SendGrid… whatever the host uses;
 *   - `SmsTransport`   — Twilio, a carrier gateway…;
 *   - `TeamsTransport` — posts an Adaptive Card. `createTeamsWebhookTransport` is a ready-made
 *     transport for Teams/Workflows incoming webhooks, using the hardened fetch and an allow-list
 *     of Microsoft webhook hosts.
 *
 * Recording test doubles (`createRecording*Transport`) capture what would have been sent.
 *
 * Every channel validates its target address before sending and returns a `failed` delivery
 * (never throws) when the address is malformed or the transport fails. Renderers decide what
 * text leaves the platform: the defaults send the title, the body and an optional deep link,
 * and never `data`.
 */
// no-raw-fetch: allow (reason: the only `fetch` here is the hardened closure from createHardenedFetch)

import { createHardenedFetch, newUUIDv7, type CapabilityId, type ExecutionContext } from '@weaveintel/core';
import type { ChannelTarget, NotificationChannel, NotificationDelivery, NotificationMessage } from '@weaveintel/core';

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** What an email transport is asked to send. */
export interface EmailEnvelope {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  /** Extra headers, e.g. `List-Unsubscribe`. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface EmailTransport {
  /** Send one email. Resolve with the provider's id; reject on failure. */
  send(ctx: ExecutionContext, envelope: EmailEnvelope): Promise<{ readonly providerId: string }>;
}

export interface EmailChannelOptions {
  readonly transport: EmailTransport;
  /** Sender address, e.g. `"Geni <noreply@example.com>"`. */
  readonly from: string;
  readonly id?: string;
  /** Builds subject and body. Defaults to title / body + deep link. */
  readonly render?: (msg: NotificationMessage) => { subject: string; text: string; html?: string };
  readonly headers?: Readonly<Record<string, string>>;
}

// Deliberately simple and bounded: one @, no spaces or angle brackets, a dotted domain.
const EMAIL_RE = /^[^\s@<>"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;

function stripControl(s: string): string {
  // Header injection guard: a subject must be one line.
  return s.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim();
}

function defaultEmailRender(msg: NotificationMessage): { subject: string; text: string; html?: string } {
  const parts = [msg.body ?? msg.title];
  if (msg.deepLink) parts.push('', msg.deepLink);
  return { subject: msg.title, text: parts.join('\n') };
}

export function createEmailChannel(opts: EmailChannelOptions): NotificationChannel {
  const id = opts.id ?? 'email';
  const render = opts.render ?? defaultEmailRender;
  return {
    id,
    capabilities: new Set<CapabilityId>(),
    async send(ctx: ExecutionContext, msg: NotificationMessage, target: ChannelTarget): Promise<NotificationDelivery> {
      const to = target.address.trim();
      if (to.length > 254 || !EMAIL_RE.test(to)) {
        return { channelId: id, messageId: newUUIDv7(), status: 'failed', detail: 'invalid email address' };
      }
      try {
        const r = render(msg);
        const { providerId } = await opts.transport.send(ctx, {
          to,
          from: opts.from,
          subject: stripControl(r.subject).slice(0, 200),
          text: r.text,
          ...(r.html ? { html: r.html } : {}),
          ...(opts.headers ? { headers: opts.headers } : {}),
        });
        return { channelId: id, messageId: providerId || newUUIDv7(), status: 'sent' };
      } catch (err) {
        return { channelId: id, messageId: newUUIDv7(), status: 'failed', detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------------

export interface SmsEnvelope {
  /** E.164, e.g. `+64211234567`. */
  readonly to: string;
  readonly text: string;
}

export interface SmsTransport {
  send(ctx: ExecutionContext, envelope: SmsEnvelope): Promise<{ readonly providerId: string }>;
}

export interface SmsChannelOptions {
  readonly transport: SmsTransport;
  readonly id?: string;
  /** Longest text sent; longer text is cut with an ellipsis. Default 320 (two segments). */
  readonly maxLength?: number;
  /**
   * Builds the text. The default sends only the title and the deep link: SMS is not a private
   * channel, so the body is left out unless the renderer adds it.
   */
  readonly render?: (msg: NotificationMessage) => string;
}

const E164_RE = /^\+[1-9]\d{6,14}$/;

export function createSmsChannel(opts: SmsChannelOptions): NotificationChannel {
  const id = opts.id ?? 'sms';
  const max = Math.max(20, opts.maxLength ?? 320);
  const render = opts.render ?? ((m: NotificationMessage) => (m.deepLink ? `${m.title} ${m.deepLink}` : m.title));
  return {
    id,
    capabilities: new Set<CapabilityId>(),
    async send(ctx: ExecutionContext, msg: NotificationMessage, target: ChannelTarget): Promise<NotificationDelivery> {
      const to = target.address.replace(/[\s()-]/g, '');
      if (!E164_RE.test(to)) {
        return { channelId: id, messageId: newUUIDv7(), status: 'failed', detail: 'invalid E.164 number' };
      }
      try {
        let text = render(msg).replace(/\s+/g, ' ').trim();
        if (text.length > max) text = `${text.slice(0, max - 1)}…`;
        const { providerId } = await opts.transport.send(ctx, { to, text });
        return { channelId: id, messageId: providerId || newUUIDv7(), status: 'sent' };
      } catch (err) {
        return { channelId: id, messageId: newUUIDv7(), status: 'failed', detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Microsoft Teams
// ---------------------------------------------------------------------------

/** The Adaptive Card body a Teams webhook accepts (`type: 'message'` with one card attachment). */
export interface TeamsCardPayload {
  readonly type: 'message';
  readonly attachments: ReadonlyArray<{
    readonly contentType: 'application/vnd.microsoft.card.adaptive';
    readonly content: Record<string, unknown>;
  }>;
}

export interface TeamsTransport {
  /** Post `payload` to the webhook at `url`. Reject on failure. */
  post(ctx: ExecutionContext, url: string, payload: TeamsCardPayload): Promise<void>;
}

export interface TeamsChannelOptions {
  readonly transport: TeamsTransport;
  readonly id?: string;
  /** Builds the card. The default shows the title, body and an "Open" button for the deep link. */
  readonly render?: (msg: NotificationMessage) => TeamsCardPayload;
}

/** Hosts Microsoft issues Teams / Workflows incoming-webhook URLs on. */
export const DEFAULT_TEAMS_WEBHOOK_HOSTS: readonly string[] = [
  'webhook.office.com',
  'logic.azure.com',
  'api.powerplatform.com',
  'powerautomate.com',
];

/** True when `url` is https and its host is one of `allowedHosts` or a subdomain of one. */
export function isAllowedWebhookUrl(url: string, allowedHosts: readonly string[] = DEFAULT_TEAMS_WEBHOOK_HOSTS): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

export function defaultTeamsCard(msg: NotificationMessage): TeamsCardPayload {
  const body: Array<Record<string, unknown>> = [
    { type: 'TextBlock', text: msg.title, weight: 'Bolder', size: 'Medium', wrap: true },
  ];
  if (msg.body) body.push({ type: 'TextBlock', text: msg.body, wrap: true });
  const actions = msg.deepLink && /^https:\/\//i.test(msg.deepLink)
    ? [{ type: 'Action.OpenUrl', title: 'Open', url: msg.deepLink }]
    : [];
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body,
        ...(actions.length > 0 ? { actions } : {}),
      },
    }],
  };
}

export function createTeamsChannel(opts: TeamsChannelOptions): NotificationChannel {
  const id = opts.id ?? 'teams';
  const render = opts.render ?? defaultTeamsCard;
  return {
    id,
    capabilities: new Set<CapabilityId>(),
    async send(ctx: ExecutionContext, msg: NotificationMessage, target: ChannelTarget): Promise<NotificationDelivery> {
      try {
        await opts.transport.post(ctx, target.address, render(msg));
        return { channelId: id, messageId: newUUIDv7(), status: 'sent' };
      } catch (err) {
        return { channelId: id, messageId: newUUIDv7(), status: 'failed', detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export interface TeamsWebhookTransportOptions {
  /** Hosts a webhook URL may point at. Defaults to `DEFAULT_TEAMS_WEBHOOK_HOSTS`. */
  readonly allowedHosts?: readonly string[];
  readonly timeoutMs?: number;
}

/**
 * Posts to a Teams / Workflows incoming webhook through the hardened (SSRF-guarded) fetch. A URL
 * that is not https or not on an allowed Microsoft host is refused before any request is made.
 */
export function createTeamsWebhookTransport(opts: TeamsWebhookTransportOptions = {}): TeamsTransport {
  const { fetch } = createHardenedFetch({ errorTag: 'notifications:teams', timeoutMs: opts.timeoutMs ?? 10_000 });
  const allowed = opts.allowedHosts ?? DEFAULT_TEAMS_WEBHOOK_HOSTS;
  return {
    async post(_ctx, url, payload) {
      if (!isAllowedWebhookUrl(url, allowed)) throw new Error('Teams webhook URL is not https on an allowed host');
      const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!resp.ok) throw new Error(`Teams webhook returned HTTP ${resp.status}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** An email transport that records instead of sending. Set `fail` to make sends reject. */
export function createRecordingEmailTransport(): EmailTransport & { readonly sent: EmailEnvelope[]; fail?: Error } {
  const sent: EmailEnvelope[] = [];
  const t = {
    sent,
    fail: undefined as Error | undefined,
    async send(_ctx: ExecutionContext, envelope: EmailEnvelope) {
      if (t.fail) throw t.fail;
      sent.push(envelope);
      return { providerId: `email-${sent.length}` };
    },
  };
  return t;
}

/** An SMS transport that records instead of sending. */
export function createRecordingSmsTransport(): SmsTransport & { readonly sent: SmsEnvelope[]; fail?: Error } {
  const sent: SmsEnvelope[] = [];
  const t = {
    sent,
    fail: undefined as Error | undefined,
    async send(_ctx: ExecutionContext, envelope: SmsEnvelope) {
      if (t.fail) throw t.fail;
      sent.push(envelope);
      return { providerId: `sms-${sent.length}` };
    },
  };
  return t;
}

/** A Teams transport that records instead of posting; it applies the same URL allow-list. */
export function createRecordingTeamsTransport(
  allowedHosts: readonly string[] = DEFAULT_TEAMS_WEBHOOK_HOSTS,
): TeamsTransport & { readonly posted: Array<{ url: string; payload: TeamsCardPayload }>; fail?: Error } {
  const posted: Array<{ url: string; payload: TeamsCardPayload }> = [];
  const t = {
    posted,
    fail: undefined as Error | undefined,
    async post(_ctx: ExecutionContext, url: string, payload: TeamsCardPayload) {
      if (!isAllowedWebhookUrl(url, allowedHosts)) throw new Error('Teams webhook URL is not https on an allowed host');
      if (t.fail) throw t.fail;
      posted.push({ url, payload });
    },
  };
  return t;
}
