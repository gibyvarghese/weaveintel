// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach } from 'vitest';
import { weaveContext } from '@weaveintel/core';
import type { NotificationMessage } from '@weaveintel/core';
import { createInMemoryFeedStore, createInAppChannel, INAPP_CHANNEL_ID } from './feed.js';
import { notificationFeedStoreContract } from './feed-contract.js';

// The in-memory reference adapter must pass the shared contract.
notificationFeedStoreContract(() => createInMemoryFeedStore(), { describe, it, beforeEach, expect } as never);

describe('createInAppChannel', () => {
  it('writes a feed row from a NotificationMessage and dedupes on the message id', async () => {
    const store = createInMemoryFeedStore();
    const channel = createInAppChannel(store);
    expect(channel.id).toBe(INAPP_CHANNEL_ID);

    const msg: NotificationMessage = {
      id: 'evt-1', tenantId: 'tA', principalId: 'alice',
      category: 'run', title: 'Run completed', deepLink: 'geneweave://run/r1', priority: 'normal',
    };
    const ctx = weaveContext({ userId: 'alice', tenantId: 'tA' });
    const d1 = await channel.send(ctx, msg, { kind: INAPP_CHANNEL_ID, address: 'alice' });
    expect(d1.status).toBe('sent');

    const list = await store.list('tA', 'alice');
    expect(list.length).toBe(1);
    expect(list[0]!.title).toBe('Run completed');
    expect(list[0]!.deepLink).toBe('geneweave://run/r1');

    // Re-delivering the SAME event id must not create a second inbox row.
    await channel.send(ctx, msg, { kind: INAPP_CHANNEL_ID, address: 'alice' });
    expect((await store.list('tA', 'alice')).length).toBe(1);
  });
});
