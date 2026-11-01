/**
 * Notification type registry, preference suppression and email/SMS/Teams channels
 * (GAPS G-WI-15, G-WI-16, G-WI-17).
 *
 * Before: only a channel registry existed (no types, `category` closed), the SuppressionPolicy had
 * no preference implementation, and there were no email, SMS or Teams channels.
 */
import { describe, expect, it } from 'vitest';
import { weaveContext, type NotificationMessage } from '@weaveintel/core';
import * as notifications from './index.js';
import {
  buildDigestNotification,
  buildNotification,
  createChannelRegistry,
  createEmailChannel,
  createInMemoryDigestSink,
  createMemoryTargetStore,
  createNotificationDispatcher,
  createNotificationTypeRegistry,
  createRecordingEmailTransport,
  createRecordingSmsTransport,
  createRecordingTeamsTransport,
  createSmsChannel,
  createTeamsChannel,
  inQuietHours,
  NotificationTypeError,
  preferenceSuppression,
  resolveEffectivePreference,
  typeKeyOf,
  type NotificationPreference,
  type NotificationTypeDefinition,
} from './index.js';

const ctx = weaveContext();

const CAB: NotificationTypeDefinition = {
  key: 'itsm.change.cab_scheduled',
  category: 'task',
  channels: ['email', 'in-app'],
  templates: { default: { title: 'CAB scheduled for {{change}}', body: 'Meets {{when}}' }, email: { title: 'CAB: {{change}}' } },
  priority: 'normal',
  digestable: true,
  breakthrough: false,
  dedupe: { strategy: 'collapse', keyTemplate: '{{change}}' },
};
const P1: NotificationTypeDefinition = {
  key: 'itsm.incident.p1_assigned',
  category: 'task',
  channels: ['sms', 'email'],
  templates: { default: { title: 'P1 assigned to you' } },
  priority: 'high',
  digestable: false,
  breakthrough: true,
  permission: 'app.itsm.incident.read',
};

describe('exports', () => {
  it('exposes the registry, preference policy and new channels', () => {
    for (const name of ['createNotificationTypeRegistry', 'preferenceSuppression', 'createEmailChannel', 'createSmsChannel', 'createTeamsChannel']) {
      expect(typeof (notifications as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});

describe('NotificationTypeRegistry (G-WI-15)', () => {
  it('registers <app>.<module>.<event> types and builds a notification with type_key in data', () => {
    const types = createNotificationTypeRegistry([CAB]);
    const msg = buildNotification(types, CAB.key, {
      id: 'n1', tenantId: 't1', principalId: 'u1', vars: { change: 'CHG001', when: 'Tue 10:00' }, channelId: 'email',
    });
    expect(msg.title).toBe('CAB: CHG001');
    expect(msg.category).toBe('task');
    expect(typeKeyOf(msg)).toBe(CAB.key);
    expect(msg.collapseKey).toBe('itsm.change.cab_scheduled:CHG001');
    // Template variables are rendered, not copied into the client payload.
    expect(msg.data).toEqual({ type_key: CAB.key });
    expect(types.list('itsm.')).toHaveLength(1);
  });

  it('refuses malformed, duplicate and contradictory definitions', () => {
    const types = createNotificationTypeRegistry([CAB]);
    expect(() => types.registerType(CAB)).toThrow(NotificationTypeError);
    expect(() => types.registerType({ ...CAB, key: 'itsm.change' })).toThrow(/<app>.<module>.<event>/);
    expect(() => types.registerType({ ...CAB, key: 'itsm.change.x', channels: [] })).toThrow(/channel/);
    expect(() => types.registerType({ ...CAB, key: 'itsm.change.y', breakthrough: true })).toThrow(/digestable and breakthrough/);
    expect(() => types.registerType({ ...CAB, key: 'itsm.change.z', templates: { default: { title: 'x' }, sms: { title: 'y' } } })).toThrow(/sms/);
  });

  it('refuses to build with a missing template value or an unknown type', () => {
    const types = createNotificationTypeRegistry([CAB]);
    expect(() => buildNotification(types, CAB.key, { id: 'n', tenantId: 't', principalId: 'u', vars: { change: 'C' } })).toThrow(/when/);
    expect(() => buildNotification(types, 'itsm.nope.nope', { id: 'n', tenantId: 't', principalId: 'u' })).toThrow(/not registered/);
  });
});

describe('preference resolution (G-WI-16)', () => {
  it('org → role → user layering, most specific row in a layer, policy wins and is final', () => {
    const rows: NotificationPreference[] = [
      { level: 'org', typeKey: '*', delivery: 'immediate' },
      { level: 'role', typeKey: 'itsm.change.*', delivery: 'digest' },
      { level: 'user', typeKey: CAB.key, channelId: 'email', delivery: 'immediate' },
      { level: 'user', typeKey: '*', enabled: false, channelId: 'sms' },
    ];
    expect(resolveEffectivePreference(rows, { typeKey: CAB.key, channelId: 'email' }).delivery).toBe('immediate');
    expect(resolveEffectivePreference(rows, { typeKey: CAB.key, channelId: 'in-app' }).delivery).toBe('digest');
    const locked = [...rows, { level: 'policy' as const, typeKey: CAB.key, delivery: 'digest' as const }];
    const eff = resolveEffectivePreference(locked, { typeKey: CAB.key, channelId: 'email' });
    expect(eff.delivery).toBe('digest');
    expect(eff.source.delivery).toBe('policy');
  });

  it('knows quiet hours across midnight in the configured time zone', () => {
    const q = { start: '22:00', end: '07:00', timeZone: 'Pacific/Auckland' };
    // 2026-11-01 is NZDT (UTC+13): 10:00Z = 23:00 local, 20:00Z = 09:00 next day local.
    expect(inQuietHours(q, new Date('2026-11-01T10:00:00Z'))).toBe(true);
    expect(inQuietHours(q, new Date('2026-11-01T20:00:00Z'))).toBe(false);
    expect(inQuietHours({ ...q, start: '07:00', end: '07:00' }, new Date('2026-11-01T10:00:00Z'))).toBe(false);
  });
});

function setup(prefs: NotificationPreference[], opts: { permission?: boolean; now?: string; resolveThrows?: boolean } = {}) {
  const types = createNotificationTypeRegistry([CAB, P1]);
  const email = createRecordingEmailTransport();
  const sms = createRecordingSmsTransport();
  const channels = createChannelRegistry();
  channels.register(createEmailChannel({ transport: email, from: 'noreply@example.com' }));
  channels.register(createSmsChannel({ transport: sms }));
  const targets = createMemoryTargetStore();
  const digest = createInMemoryDigestSink();
  const dispatcher = createNotificationDispatcher({
    channels,
    targets,
    types,
    digest,
    ...(opts.permission !== undefined ? { permissionCheck: async () => opts.permission! } : {}),
    suppression: preferenceSuppression({
      types,
      now: () => new Date(opts.now ?? '2026-11-01T00:00:00Z'), // 13:00 NZDT
      resolvePrefs: async () => {
        if (opts.resolveThrows) throw new Error('prefs store down');
        return prefs;
      },
    }),
  });
  return { types, email, sms, targets, digest, dispatcher };
}

async function addTargets(targets: ReturnType<typeof createMemoryTargetStore>) {
  await targets.upsert({ tenantId: 't1', principalId: 'u1', channelId: 'email', target: { kind: 'email', address: 'u1@example.com' } });
  await targets.upsert({ tenantId: 't1', principalId: 'u1', channelId: 'sms', target: { kind: 'sms', address: '+64 21 123 4567' } });
}

describe('dispatcher with types and preferences (G-WI-15/16)', () => {
  const quiet = { start: '22:00', end: '07:00', timeZone: 'Pacific/Auckland' };

  it('sends a typed notification only on its default channels unless a person opts in', async () => {
    const { types, email, sms, targets, dispatcher } = setup([]);
    await addTargets(targets);
    const msg = buildNotification(types, CAB.key, { id: 'n1', tenantId: 't1', principalId: 'u1', vars: { change: 'CHG1', when: 'now' } });
    const r = await dispatcher.notify(ctx, 'u1', 't1', msg);
    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(0);
    expect(r.skipped).toEqual([{ channelId: 'sms', reason: 'disabled' }]);

    const optIn = setup([{ level: 'user', typeKey: CAB.key, channelId: 'sms', enabled: true }]);
    await addTargets(optIn.targets);
    await optIn.dispatcher.notify(ctx, 'u1', 't1', msg);
    expect(optIn.sms.sent).toHaveLength(1);
  });

  it('holds a digestable type during quiet hours, and a digest builds one summary', async () => {
    const { types, email, targets, digest, dispatcher } = setup([{ level: 'user', quietHours: quiet }], { now: '2026-11-01T10:00:00Z' });
    await addTargets(targets);
    const msg = buildNotification(types, CAB.key, { id: 'n1', tenantId: 't1', principalId: 'u1', vars: { change: 'CHG1', when: 'now' } });
    const r = await dispatcher.notify(ctx, 'u1', 't1', msg);
    expect(email.sent).toHaveLength(0);
    expect(r.digested).toBe(1);
    const held = await digest.drain('t1', 'u1');
    const summary = buildDigestNotification(held, { id: 'd1', tenantId: 't1', principalId: 'u1' });
    expect(summary.title).toBe('1 notification while you were away');
    expect(summary.body).toContain('CAB scheduled for CHG1');
  });

  it('lets a breakthrough type through quiet hours', async () => {
    const { types, sms, targets, dispatcher } = setup([{ level: 'user', quietHours: quiet }], { now: '2026-11-01T10:00:00Z', permission: true });
    await addTargets(targets);
    const msg = buildNotification(types, P1.key, { id: 'n2', tenantId: 't1', principalId: 'u1' });
    await dispatcher.notify(ctx, 'u1', 't1', msg);
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]?.to).toBe('+64211234567');
  });

  it('withholds a type whose permission is denied, or when no permission check is wired', async () => {
    const denied = setup([], { permission: false });
    await addTargets(denied.targets);
    const msg = buildNotification(denied.types, P1.key, { id: 'n3', tenantId: 't1', principalId: 'u1' });
    const r = await denied.dispatcher.notify(ctx, 'u1', 't1', msg);
    expect(r.deliveries).toHaveLength(0);
    expect(r.skipped?.[0]?.reason).toBe('permission_denied');

    const unchecked = setup([]);
    await addTargets(unchecked.targets);
    const r2 = await unchecked.dispatcher.notify(ctx, 'u1', 't1', msg);
    expect(r2.skipped?.[0]?.reason).toBe('permission_unchecked');
    expect(unchecked.sms.sent).toHaveLength(0);
  });

  it('withholds an unregistered type and fails closed when preferences cannot be read', async () => {
    const { targets, email, dispatcher } = setup([]);
    await addTargets(targets);
    const unknown: NotificationMessage = { id: 'n4', tenantId: 't1', principalId: 'u1', category: 'task', title: 'x', data: { type_key: 'itsm.unknown.thing' } };
    const r = await dispatcher.notify(ctx, 'u1', 't1', unknown);
    expect(r.skipped?.every((s) => s.reason === 'unknown_type')).toBe(true);

    const broken = setup([], { resolveThrows: true });
    await addTargets(broken.targets);
    const msg = buildNotification(broken.types, CAB.key, { id: 'n5', tenantId: 't1', principalId: 'u1', vars: { change: 'C', when: 'w' } });
    const r2 = await broken.dispatcher.notify(ctx, 'u1', 't1', msg);
    expect(broken.email.sent).toHaveLength(0);
    expect(r2.skipped?.map((s) => s.reason)).toContain('policy_error');
    expect(email.sent).toHaveLength(0);
  });
});

describe('email, SMS and Teams channels (G-WI-17)', () => {
  const msg: NotificationMessage = {
    id: 'n', tenantId: 't', principalId: 'u', category: 'task',
    title: 'Approve CHG1\r\nBcc: evil@example.com', body: 'Details', deepLink: 'https://app.example.com/x',
    data: { secret: 'never-sent' },
  };

  it('email: one-line subject, no data payload, malformed address fails without sending', async () => {
    const t = createRecordingEmailTransport();
    const ch = createEmailChannel({ transport: t, from: 'noreply@example.com' });
    const ok = await ch.send(ctx, msg, { kind: 'email', address: 'a@example.com' });
    expect(ok.status).toBe('sent');
    expect(t.sent[0]?.subject).toBe('Approve CHG1 Bcc: evil@example.com');
    expect(JSON.stringify(t.sent[0])).not.toContain('never-sent');
    const bad = await ch.send(ctx, msg, { kind: 'email', address: 'not an address' });
    expect(bad.status).toBe('failed');
    expect(t.sent).toHaveLength(1);
  });

  it('sms: E.164 only, title and link without the body, bounded length', async () => {
    const t = createRecordingSmsTransport();
    const ch = createSmsChannel({ transport: t, maxLength: 40 });
    expect((await ch.send(ctx, msg, { kind: 'sms', address: '021 123 4567' })).status).toBe('failed');
    expect((await ch.send(ctx, msg, { kind: 'sms', address: '+64 21 123 4567' })).status).toBe('sent');
    expect(t.sent[0]?.text.length).toBeLessThanOrEqual(40);
    expect(t.sent[0]?.text).not.toContain('Details');
  });

  it('teams: posts an Adaptive Card only to https Microsoft webhook hosts', async () => {
    const t = createRecordingTeamsTransport();
    const ch = createTeamsChannel({ transport: t });
    const ok = await ch.send(ctx, msg, { kind: 'teams', address: 'https://contoso.webhook.office.com/webhookb2/abc' });
    expect(ok.status).toBe('sent');
    const card = t.posted[0]?.payload.attachments[0]?.content as { type: string; actions?: unknown[] };
    expect(card.type).toBe('AdaptiveCard');
    expect(card.actions).toHaveLength(1);
    for (const address of ['http://contoso.webhook.office.com/x', 'https://evil.example.com/webhook.office.com', 'https://webhook.office.com.evil.com/x']) {
      expect((await ch.send(ctx, msg, { kind: 'teams', address })).status, address).toBe('failed');
    }
    expect(t.posted).toHaveLength(1);
  });

  it('a failing transport becomes a failed delivery, not a throw', async () => {
    const t = createRecordingEmailTransport();
    t.fail = new Error('relay down');
    const r = await createEmailChannel({ transport: t, from: 'n@example.com' }).send(ctx, msg, { kind: 'email', address: 'a@example.com' });
    expect(r).toMatchObject({ status: 'failed', detail: 'relay down' });
  });
});
