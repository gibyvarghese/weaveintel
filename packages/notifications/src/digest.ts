/**
 * DigestSink — where notifications held for a digest wait until the next digest run.
 *
 * The dispatcher puts a notification here when the preference policy answers `digest` (quiet
 * hours, or a person who asked for digests). A scheduled job later drains each person's entries
 * and sends one summary with `buildDigestNotification`. The host supplies a durable sink; the
 * in-memory one is for tests and single-process tools.
 */

import type { ExecutionContext, NotificationMessage } from '@weaveintel/core';

export interface DigestEntry {
  readonly tenantId: string;
  readonly principalId: string;
  readonly channelId: string;
  readonly typeKey?: string;
  readonly msg: NotificationMessage;
  /** ISO-8601 time the entry was held. */
  readonly heldAt: string;
}

export interface DigestSink {
  add(ctx: ExecutionContext, entry: DigestEntry): Promise<void>;
}

export interface InMemoryDigestSink extends DigestSink {
  /** Remove and return a person's held entries, oldest first. */
  drain(tenantId: string, principalId: string): Promise<DigestEntry[]>;
  /** Number of entries held for a person. */
  size(tenantId: string, principalId: string): number;
}

export function createInMemoryDigestSink(): InMemoryDigestSink {
  const held = new Map<string, DigestEntry[]>();
  const keyOf = (tenantId: string, principalId: string) => `${tenantId}\u0000${principalId}`;
  return {
    async add(_ctx, entry) {
      const k = keyOf(entry.tenantId, entry.principalId);
      const list = held.get(k) ?? [];
      // One entry per notification id and channel: a retry doesn't double up the digest.
      if (!list.some((e) => e.msg.id === entry.msg.id && e.channelId === entry.channelId)) list.push(entry);
      held.set(k, list);
    },
    async drain(tenantId, principalId) {
      const k = keyOf(tenantId, principalId);
      const list = held.get(k) ?? [];
      held.delete(k);
      return list;
    },
    size(tenantId, principalId) {
      return held.get(keyOf(tenantId, principalId))?.length ?? 0;
    },
  };
}

/**
 * One summary notification for a set of held entries. Titles of the held notifications are
 * listed in the body; pass `listTitles: false` to send counts only (for channels such as push
 * where subject lines must not travel).
 */
export function buildDigestNotification(
  entries: readonly DigestEntry[],
  opts: { id: string; tenantId: string; principalId: string; title?: string; listTitles?: boolean; maxItems?: number },
): NotificationMessage {
  const max = opts.maxItems ?? 20;
  const lines = opts.listTitles === false
    ? []
    : entries.slice(0, max).map((e) => `• ${e.msg.title}`);
  if (opts.listTitles !== false && entries.length > max) lines.push(`…and ${entries.length - max} more`);
  const byType = new Map<string, number>();
  for (const e of entries) byType.set(e.typeKey ?? e.msg.category, (byType.get(e.typeKey ?? e.msg.category) ?? 0) + 1);
  return {
    id: opts.id,
    tenantId: opts.tenantId,
    principalId: opts.principalId,
    category: 'custom',
    title: opts.title ?? `${entries.length} notification${entries.length === 1 ? '' : 's'} while you were away`,
    ...(lines.length > 0 ? { body: lines.join('\n') } : {}),
    data: { type_key: 'platform.notification.digest', counts: Object.fromEntries(byType) },
    priority: 'normal',
  };
}
