/**
 * ChannelRegistry — resolves notification channels by id at dispatch time.
 *
 * Channels are registered once at boot; the registry is used by the dispatcher
 * to fan out a notification to the appropriate channel.
 */

import type { NotificationChannel } from '@weaveintel/core';

export interface ChannelRegistry {
  /** Register a channel under its `channel.id`. Overwrites any prior registration. */
  register(channel: NotificationChannel): void;
  /** Resolve a channel by id. Returns undefined when not registered. */
  resolve(id: string): NotificationChannel | undefined;
  /** List all registered channel ids. */
  ids(): readonly string[];
}

export function createChannelRegistry(): ChannelRegistry {
  const map = new Map<string, NotificationChannel>();
  return {
    register(channel) { map.set(channel.id, channel); },
    resolve(id) { return map.get(id); },
    ids() { return [...map.keys()]; },
  };
}
