/**
 * Push channel over a host transport, with a `render` that decides what leaves the platform.
 *
 * --- For someone new to this ---
 * A push notification is drawn on a lock screen, which anybody standing next to the phone can read.
 * So what a push carries is a policy decision, not a formatting detail: many platforms send only
 * "You have a new approval" and keep the record's title inside the app. `render` is where that
 * decision lives. It receives the whole notification and returns exactly the title, body and data the
 * push payload will carry — nothing else from the message travels.
 *
 * Like the email, SMS and Teams channels, the channel is a thin adapter over a *transport* the host
 * supplies (web push with VAPID, APNs, FCM, or a recording double in tests). The library holds no
 * credentials and makes no network call of its own here.
 *
 * Example — a render that keeps record titles off the lock screen:
 *
 *   createPushChannel({
 *     transport,
 *     render: (msg) => ({ title: 'New approval', data: { type_key: msg.data?.type_key } }),
 *   })
 */

import { newUUIDv7, type ExecutionContext, type CapabilityId } from '@weaveintel/core';
import type { NotificationChannel, NotificationMessage, ChannelTarget, NotificationDelivery } from '@weaveintel/core';

/** Exactly what a push payload carries. Nothing else from the notification is sent. */
export interface PushContent {
  readonly title: string;
  readonly body?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Delivers one push payload to one device or subscription (`target.address`). */
export interface PushTransport {
  send(ctx: ExecutionContext, target: ChannelTarget, content: PushContent): Promise<{ readonly providerId: string }>;
}

export interface PushChannelOptions {
  readonly transport: PushTransport;
  /** Channel id. Default `push`. */
  readonly id?: string;
  /**
   * What the payload carries. Default: the notification's title, body and data (the behaviour of the
   * web-push, APNs and FCM channels). Supply one that leaves out record titles for anything sensitive.
   */
  readonly render?: (msg: NotificationMessage) => PushContent;
}

/** The default push content: title, body and data, as the HTTP push channels have always sent. */
export function defaultPushRender(msg: NotificationMessage): PushContent {
  return { title: msg.title, ...(msg.body ? { body: msg.body } : {}), ...(msg.data ? { data: msg.data } : {}) };
}

/**
 * A push channel. Returns a `failed` delivery (never throws) when the transport or the render fails,
 * like every other channel here.
 */
export function createPushChannel(opts: PushChannelOptions): NotificationChannel {
  const id = opts.id ?? 'push';
  const render = opts.render ?? defaultPushRender;
  return {
    id,
    capabilities: new Set<CapabilityId>(),
    async send(ctx: ExecutionContext, msg: NotificationMessage, target: ChannelTarget): Promise<NotificationDelivery> {
      try {
        const content = render(msg);
        if (!content.title) throw new Error('push render returned no title');
        await opts.transport.send(ctx, target, content);
        return { channelId: id, messageId: newUUIDv7(), status: 'sent' };
      } catch (err) {
        return { channelId: id, messageId: newUUIDv7(), status: 'failed', detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** A push transport that records what it would have sent, for tests and development. Set `fail` to make it throw. */
export function createRecordingPushTransport(): PushTransport & {
  readonly sent: Array<{ address: string; content: PushContent }>;
  fail?: Error;
} {
  const sent: Array<{ address: string; content: PushContent }> = [];
  const transport = {
    sent,
    fail: undefined as Error | undefined,
    async send(_ctx: ExecutionContext, target: ChannelTarget, content: PushContent) {
      if (transport.fail) throw transport.fail;
      sent.push({ address: target.address, content });
      return { providerId: `push-${sent.length}` };
    },
  };
  return transport;
}
