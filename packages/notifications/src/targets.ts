/**
 * TargetStore — persisted principal-to-channel binding records.
 *
 * A `TargetRecord` represents a single registered delivery endpoint for a
 * principal (e.g., a device token, webhook URL, or push subscription).
 *
 * Two implementations ship:
 *   - `createMemoryTargetStore()` — in-memory, for tests and zero-config DX
 *   - `createKvTargetStore(kv)` — backed by any RuntimeKvStore (SQLite, Postgres, …)
 */

import type { RuntimeKvStore } from '@weaveintel/core';
import type { ChannelTarget } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';

// ---------------------------------------------------------------------------
// TargetRecord
// ---------------------------------------------------------------------------

export interface TargetRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  /** Matches a registered channel id. */
  readonly channelId: string;
  /** Channel-level target (address = device token, URL, etc.). */
  readonly target: ChannelTarget;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Optional labels for filtering (e.g., platform, environment). */
  readonly labels?: Record<string, string>;
}

export interface CreateTargetInput {
  tenantId: string;
  principalId: string;
  channelId: string;
  target: ChannelTarget;
  labels?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// TargetStore interface
// ---------------------------------------------------------------------------

export interface TargetStore {
  upsert(input: CreateTargetInput): Promise<TargetRecord>;
  getById(id: string): Promise<TargetRecord | undefined>;
  listByPrincipal(tenantId: string, principalId: string): Promise<readonly TargetRecord[]>;
  remove(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Memory implementation
// ---------------------------------------------------------------------------

export function createMemoryTargetStore(): TargetStore {
  const map = new Map<string, TargetRecord>();

  return {
    async upsert(input) {
      const now = new Date().toISOString();
      // Upsert by (tenantId, principalId, channelId, address) uniqueness
      for (const [key, rec] of map) {
        if (
          rec.tenantId === input.tenantId &&
          rec.principalId === input.principalId &&
          rec.channelId === input.channelId &&
          rec.target.address === input.target.address
        ) {
          const updated: TargetRecord = { ...rec, target: input.target, labels: input.labels, updatedAt: now };
          map.set(key, updated);
          return updated;
        }
      }
      const id = newUUIDv7();
      const record: TargetRecord = { id, ...input, createdAt: now, updatedAt: now };
      map.set(id, record);
      return record;
    },
    async getById(id) { return map.get(id); },
    async listByPrincipal(tenantId, principalId) {
      return [...map.values()].filter(r => r.tenantId === tenantId && r.principalId === principalId);
    },
    async remove(id) { map.delete(id); },
  };
}

// ---------------------------------------------------------------------------
// KV-backed implementation
// ---------------------------------------------------------------------------

const KV_NS = 'notif-target';

export function createKvTargetStore(kv: RuntimeKvStore): TargetStore {
  const key = (id: string) => `${KV_NS}:${id}`;
  const principalKey = (tenantId: string, principalId: string) => `${KV_NS}-idx:${tenantId}:${principalId}`;

  async function loadIndex(tenantId: string, principalId: string): Promise<string[]> {
    const raw = await kv.get(principalKey(tenantId, principalId));
    if (!raw) return [];
    try { return JSON.parse(raw) as string[]; } catch { return []; }
  }

  async function saveIndex(tenantId: string, principalId: string, ids: string[]): Promise<void> {
    await kv.set(principalKey(tenantId, principalId), JSON.stringify(ids));
  }

  return {
    async upsert(input) {
      const now = new Date().toISOString();
      const idx = await loadIndex(input.tenantId, input.principalId);
      // Check for duplicate address in existing records
      for (const existingId of idx) {
        const raw = await kv.get(key(existingId));
        if (!raw) continue;
        const rec = JSON.parse(raw) as TargetRecord;
        if (rec.channelId === input.channelId && rec.target.address === input.target.address) {
          const updated: TargetRecord = { ...rec, target: input.target, labels: input.labels, updatedAt: now };
          await kv.set(key(existingId), JSON.stringify(updated));
          return updated;
        }
      }
      const id = newUUIDv7();
      const record: TargetRecord = { id, ...input, createdAt: now, updatedAt: now };
      await kv.set(key(id), JSON.stringify(record));
      await saveIndex(input.tenantId, input.principalId, [...idx, id]);
      return record;
    },
    async getById(id) {
      const raw = await kv.get(key(id));
      if (!raw) return undefined;
      return JSON.parse(raw) as TargetRecord;
    },
    async listByPrincipal(tenantId, principalId) {
      const idx = await loadIndex(tenantId, principalId);
      const records: TargetRecord[] = [];
      for (const id of idx) {
        const raw = await kv.get(key(id));
        if (raw) records.push(JSON.parse(raw) as TargetRecord);
      }
      return records;
    },
    async remove(id) {
      const raw = await kv.get(key(id));
      if (!raw) return;
      const rec = JSON.parse(raw) as TargetRecord;
      await kv.delete(key(id));
      const idx = await loadIndex(rec.tenantId, rec.principalId);
      await saveIndex(rec.tenantId, rec.principalId, idx.filter(i => i !== id));
    },
  };
}
