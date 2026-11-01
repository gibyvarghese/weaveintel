/**
 * Push over a host transport, with a render that decides what reaches the lock screen.
 *
 * Before: the web-push, APNs and FCM channels always sent the notification's title and body, so a
 * host could not keep a record's title off a lock screen; there was no push channel over a host
 * transport and no recording double to prove what a push carried.
 */
import { describe, expect, it } from 'vitest';
import { weaveContext, type NotificationMessage } from '@weaveintel/core';
import {
  createApnsChannel,
  createFcmChannel,
  createPushChannel,
  createRecordingPushTransport,
  createWebPushChannel,
  defaultPushRender,
} from './index.js';

const ctx = weaveContext();
const MSG: NotificationMessage = {
  id: 'n1', tenantId: 't1', principalId: 'u1', category: 'task',
  title: 'INC0042187 VPN down for the CFO', body: 'Wellington site',
  data: { type_key: 'itsm.incident.assigned' }, deepLink: '/app/itsm-incident?n=1',
};
const target = { kind: 'push', address: 'device-1' };

describe('push channel over a host transport', () => {
  it('sends exactly what the render returns, and nothing else from the message', async () => {
    const transport = createRecordingPushTransport();
    const ch = createPushChannel({
      transport,
      render: (m) => ({ title: 'Assigned to you', data: { type_key: m.data?.['type_key'] } }),
    });
    const d = await ch.send(ctx, MSG, target);
    expect(d.status).toBe('sent');
    expect(transport.sent).toEqual([{ address: 'device-1', content: { title: 'Assigned to you', data: { type_key: 'itsm.incident.assigned' } } }]);
    expect(JSON.stringify(transport.sent)).not.toContain('INC0042187');
    expect(JSON.stringify(transport.sent)).not.toContain('Wellington');
  });

  it('defaults to title, body and data, as the HTTP push channels have always sent', async () => {
    expect(defaultPushRender(MSG)).toEqual({ title: MSG.title, body: MSG.body, data: MSG.data });
    const transport = createRecordingPushTransport();
    await createPushChannel({ transport }).send(ctx, MSG, target);
    expect(transport.sent[0]?.content.title).toBe(MSG.title);
  });

  it('reports a failed delivery, never a throw, when the transport or the render fails', async () => {
    const transport = createRecordingPushTransport();
    transport.fail = new Error('gone');
    expect((await createPushChannel({ transport }).send(ctx, MSG, target)).status).toBe('failed');
    const blank = await createPushChannel({ transport: createRecordingPushTransport(), render: () => ({ title: '' }) }).send(ctx, MSG, target);
    expect(blank.status).toBe('failed');
    expect(blank.detail).toMatch(/no title/);
  });

  it('the web-push, APNs and FCM channels accept a render', () => {
    const render = () => ({ title: 'x' });
    // A typed option on each: constructing them with one must compile and not throw.
    expect(createWebPushChannel({ vapidAuthorization: 'vapid t=1', render }).id).toBe('web-push');
    expect(createApnsChannel({ bundleId: 'b', bearerToken: 't', render }).id).toBe('apns');
    expect(createFcmChannel({ projectId: 'p', accessToken: 't', render }).id).toBe('fcm');
  });
});
