/**
 * @weaveintel/a2a — Push Notification Store
 *
 * Stores webhook delivery configurations for A2A v1.0 push notifications.
 * Each task can have multiple push configs (one per webhook URL / consumer).
 *
 * JSON-RPC methods using this store:
 *   CreateTaskPushNotificationConfig → store.create(taskId, config)
 *   GetTaskPushNotificationConfig    → store.get(taskId, configId)
 *   ListTaskPushNotificationConfigs  → store.list(taskId)
 *   DeleteTaskPushNotificationConfig → store.delete(taskId, configId)
 *
 * Two implementations:
 *   createInMemoryPushNotificationStore() — ephemeral; per-process
 *   createDurablePushNotificationStore(kv) — backed by any RuntimeKvStore
 */

import type { A2APushNotificationConfig, A2APushNotificationConfigEntry, RuntimeKvStore } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';

export type { A2APushNotificationConfigEntry };

// ─── Store interface ──────────────────────────────────────────────────────────

export interface A2APushNotificationStore {
  /**
   * Register a new webhook config for a task.
   * Returns the stored entry with its server-assigned `pushConfigId`.
   */
  create(taskId: string, config: A2APushNotificationConfig): Promise<A2APushNotificationConfigEntry>;

  /**
   * Retrieve a specific config by taskId + configId.
   * Returns null if not found.
   */
  get(taskId: string, configId: string): Promise<A2APushNotificationConfigEntry | null>;

  /**
   * List all configs registered for a task.
   * Returns empty array if no configs are registered.
   */
  list(taskId: string): Promise<readonly A2APushNotificationConfigEntry[]>;

  /**
   * Delete a config by taskId + configId.
   * Returns true if the config existed and was deleted, false if not found.
   */
  delete(taskId: string, configId: string): Promise<boolean>;
}

// ─── In-memory store ──────────────────────────────────────────────────────────

/**
 * A fast, ephemeral push notification store. Suitable for development and
 * single-process deployments. State is lost on process restart.
 */
export function createInMemoryPushNotificationStore(): A2APushNotificationStore {
  // taskId → (configId → entry)
  const configs = new Map<string, Map<string, A2APushNotificationConfigEntry>>();

  function getOrCreate(taskId: string): Map<string, A2APushNotificationConfigEntry> {
    let map = configs.get(taskId);
    if (!map) {
      map = new Map();
      configs.set(taskId, map);
    }
    return map;
  }

  return {
    async create(taskId, config) {
      const entry: A2APushNotificationConfigEntry = {
        ...config,
        pushConfigId: newUUIDv7(),
        taskId,
        createdAt: new Date().toISOString(),
      };
      getOrCreate(taskId).set(entry.pushConfigId, entry);
      return entry;
    },

    async get(taskId, configId) {
      return configs.get(taskId)?.get(configId) ?? null;
    },

    async list(taskId) {
      const map = configs.get(taskId);
      if (!map) return [];
      return [...map.values()];
    },

    async delete(taskId, configId) {
      const map = configs.get(taskId);
      if (!map) return false;
      const existed = map.has(configId);
      map.delete(configId);
      if (map.size === 0) configs.delete(taskId);
      return existed;
    },
  };
}

// ─── Durable KV store ─────────────────────────────────────────────────────────

/**
 * A durable push notification store backed by any `RuntimeKvStore`.
 * Keys:
 *   `{prefix}push:{taskId}:{configId}` → JSON-serialized entry
 */
export function createDurablePushNotificationStore(
  kv: RuntimeKvStore,
  prefix = 'a2a:',
): A2APushNotificationStore {
  const entryKey = (taskId: string, configId: string) =>
    `${prefix}push:${taskId}:${configId}`;
  const taskPrefix = (taskId: string) => `${prefix}push:${taskId}:`;

  return {
    async create(taskId, config) {
      const entry: A2APushNotificationConfigEntry = {
        ...config,
        pushConfigId: newUUIDv7(),
        taskId,
        createdAt: new Date().toISOString(),
      };
      await kv.set(entryKey(taskId, entry.pushConfigId), JSON.stringify(entry));
      return entry;
    },

    async get(taskId, configId) {
      const raw = await kv.get(entryKey(taskId, configId));
      if (!raw) return null;
      try {
        return JSON.parse(raw) as A2APushNotificationConfigEntry;
      } catch {
        return null;
      }
    },

    async list(taskId) {
      const prefix = taskPrefix(taskId);
      const entries = await kv.list(prefix);
      const results: A2APushNotificationConfigEntry[] = [];
      for (const e of entries) {
        try {
          results.push(JSON.parse(e.value) as A2APushNotificationConfigEntry);
        } catch {
          // skip corrupt entries
        }
      }
      return results;
    },

    async delete(taskId, configId) {
      const key = entryKey(taskId, configId);
      const existing = await kv.get(key);
      if (!existing) return false;
      await kv.delete(key);
      return true;
    },
  };
}
