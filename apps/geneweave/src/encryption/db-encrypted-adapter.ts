/**
 * GeneWeave-specific encryption wrapper around the SQLite `DatabaseAdapter`.
 *
 * Phase 4: thin geneweave-side configuration over the package-level
 * `weaveTenantEncryptedProxy` from `@weaveintel/encryption`. This file owns:
 *   - tenant-id resolution per geneweave row shape (chat_id → user_id →
 *     tenant_id, or user_id → tenant_id directly),
 *   - per-tenant policy loading from `tenant_encryption_policy`,
 *   - the per-method spec table mapping geneweave `DatabaseAdapter` methods
 *     to the columns operators may opt into via `field_policy`.
 *
 * Encryption logic — sentinel format, AAD composition, key/epoch lookup,
 * idempotent re-write guard, lazy-upgrade tolerance — lives in the package.
 *
 * `withTenantEncryptedMessages` is preserved as a back-compat alias for
 * `withTenantEncryptedDb` so existing callers (apps/geneweave/src/index.ts)
 * keep working without churn.
 */

import type { DatabaseAdapter, ChatRow } from '../db-types.js';
import {
  type TenantKeyManager,
  type EncryptedMethodSpec,
  type TenantPolicySnapshot,
  type FieldPolicy,
  weaveTenantEncryptedProxy,
  mergeFieldPolicy,
  isFieldEncrypted,
  isEncrypted,
} from '@weaveintel/encryption';

type GetManager = () => TenantKeyManager | null;

/**
 * Wrap a `DatabaseAdapter` so writes/reads on opted-in tables are encrypted
 * under the resolved tenant policy. Idempotent: if encryption is disabled,
 * un-bootstrapped, or the tenant has no policy, this acts as a transparent
 * pass-through. Reads always tolerate plaintext (lazy-upgrade window).
 *
 * Tables wrapped today:
 *   - `messages` — `addMessage` (write), `getMessages` (read list).
 *     Default policy columns: `content`, `metadata`.
 *   - `chats` — `createChat` (write), `updateChatTitle` (write, positional),
 *     `getChat` / `getChatById` (read single), `getUserChats` (read list).
 *     Default policy columns: `title`.
 *
 * Operators add or remove columns at runtime via
 * `tenant_encryption_policy.field_policy` JSON; the wrapper merges that
 * over the package default per call.
 *
 * @param rawDb       The underlying adapter (typically `SQLiteAdapter`).
 * @param getManager  Live-binding accessor that resolves to the bootstrapped
 *                    `TenantKeyManager` or `null`. Pass
 *                    `() => geneweaveEncryptionManager` so the wrapper
 *                    picks up the post-boot value.
 */
export function withTenantEncryptedDb(
  rawDb: DatabaseAdapter,
  getManager: GetManager,
): DatabaseAdapter {
  // ── tenant resolvers ──────────────────────────────────────────────────────
  // Closures over `rawDb` so spec callbacks need only `(args, db)` shape.

  async function tenantViaUser(userId: string | null | undefined): Promise<string | null> {
    if (!userId) return null;
    try {
      const u = await rawDb.getUserById(userId);
      return u?.tenant_id ?? null;
    } catch {
      return null;
    }
  }

  async function tenantViaChat(chatId: string | null | undefined): Promise<string | null> {
    if (!chatId) return null;
    try {
      const chat: ChatRow | null = await rawDb.getChatById(chatId);
      if (!chat) return null;
      return tenantViaUser(chat.user_id);
    } catch {
      return null;
    }
  }

  // ── per-tenant policy loader ──────────────────────────────────────────────

  async function loadTenantPolicy(
    _db: unknown,
    tenantId: string,
  ): Promise<TenantPolicySnapshot | null> {
    try {
      const row = await rawDb.getTenantEncryptionPolicy(tenantId);
      if (!row) return null;
      let parsed: FieldPolicy | null = null;
      if (row.field_policy) {
        try {
          parsed = JSON.parse(row.field_policy) as FieldPolicy;
        } catch {
          parsed = null;
        }
      }
      return { enabled: row.enabled === 1, fieldPolicy: parsed };
    } catch {
      return null;
    }
  }

  // ── column accessors ──────────────────────────────────────────────────────

  const titleAccessor = {
    column: 'title',
    get: (t: { title?: string | null }) => t.title ?? null,
    set: (t: { title?: string | null }, v: string | null | undefined) => {
      t.title = v ?? null;
    },
  };
  const contentAccessor = {
    column: 'content',
    get: (t: { content?: string | null }) => t.content ?? null,
    set: (t: { content?: string | null }, v: string | null | undefined) => {
      t.content = v ?? null;
    },
  };
  const metadataAccessor = {
    column: 'metadata',
    get: (t: { metadata?: string | null }) => t.metadata ?? null,
    set: (t: { metadata?: string | null }, v: string | null | undefined) => {
      t.metadata = v ?? null;
    },
  };

  // ── method specs ──────────────────────────────────────────────────────────

  const methods: Record<string, EncryptedMethodSpec> = {
    // messages — argIndex 0 is the message payload `{ id, chatId, ... }`
    addMessage: {
      kind: 'write',
      table: 'messages',
      tenant: async (args) => tenantViaChat((args[0] as { chatId: string }).chatId),
      tenantCacheKey: (args) => `chat:${(args[0] as { chatId: string }).chatId}`,
      rowId: (args) => (args[0] as { id: string }).id,
      columns: [contentAccessor, metadataAccessor],
    },
    getMessages: {
      kind: 'read',
      table: 'messages',
      shape: 'list',
      tenant: async (row) => tenantViaChat((row as { chat_id: string }).chat_id),
      tenantCacheKey: (row) => `chat:${(row as { chat_id: string }).chat_id}`,
      rowId: (row) => (row as { id: string }).id,
      columns: [contentAccessor, metadataAccessor],
    },

    // chats — `createChat({ id, userId, title, ... })`
    createChat: {
      kind: 'write',
      table: 'chats',
      tenant: async (args) => tenantViaUser((args[0] as { userId: string }).userId),
      tenantCacheKey: (args) => `user:${(args[0] as { userId: string }).userId}`,
      rowId: (args) => (args[0] as { id: string }).id,
      columns: [titleAccessor],
    },
    getChat: {
      kind: 'read',
      table: 'chats',
      shape: 'single',
      tenant: async (row) => tenantViaUser((row as { user_id: string }).user_id),
      tenantCacheKey: (row) => `user:${(row as { user_id: string }).user_id}`,
      rowId: (row) => (row as { id: string }).id,
      columns: [titleAccessor],
    },
    getChatById: {
      kind: 'read',
      table: 'chats',
      shape: 'single',
      tenant: async (row) => tenantViaUser((row as { user_id: string }).user_id),
      tenantCacheKey: (row) => `user:${(row as { user_id: string }).user_id}`,
      rowId: (row) => (row as { id: string }).id,
      columns: [titleAccessor],
    },
    getUserChats: {
      kind: 'read',
      table: 'chats',
      shape: 'list',
      tenant: async (row) => tenantViaUser((row as { user_id: string }).user_id),
      tenantCacheKey: (row) => `user:${(row as { user_id: string }).user_id}`,
      rowId: (row) => (row as { id: string }).id,
      columns: [titleAccessor],
    },
  };

  const baseProxy = weaveTenantEncryptedProxy<DatabaseAdapter>(rawDb, {
    getManager,
    loadTenantPolicy,
    methods,
  });

  // ── outer Proxy: handle positional-arg method `updateChatTitle`. ──────────
  // The package proxy clones an object arg in-place; positional primitives
  // can't be intercepted that way, so we wrap that one method directly using
  // the same guard chain (manager null / tenant null / policy disabled /
  // column not in policy / already-sentinel → pass-through).
  return new Proxy(baseProxy, {
    get(target, prop, receiver) {
      if (prop === 'updateChatTitle') {
        return async (id: string, userId: string, title: string): Promise<void> => {
          const manager = getManager();
          if (!manager) return rawDb.updateChatTitle(id, userId, title);
          const tenantId = await tenantViaUser(userId);
          if (!tenantId) return rawDb.updateChatTitle(id, userId, title);
          const snap = await loadTenantPolicy(rawDb, tenantId);
          if (!snap?.enabled) return rawDb.updateChatTitle(id, userId, title);
          const policy = mergeFieldPolicy(snap.fieldPolicy ?? null);
          if (!isFieldEncrypted(policy, 'chats', 'title')) {
            return rawDb.updateChatTitle(id, userId, title);
          }
          if (isEncrypted(title)) {
            return rawDb.updateChatTitle(id, userId, title);
          }
          let toWrite: string = title;
          try {
            toWrite = await manager.encrypt({
              tenantId,
              table: 'chats',
              column: 'title',
              rowId: id,
              plaintext: title,
            });
          } catch {
            // graceful pass-through — never block writes
            toWrite = title;
          }
          return rawDb.updateChatTitle(id, userId, toWrite);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as DatabaseAdapter;
}

/**
 * Back-compat alias. Phase 3 wired `withTenantEncryptedMessages(db, getter)`;
 * Phase 4 generalises to multi-table but preserves the old name so existing
 * call sites keep working.
 */
export const withTenantEncryptedMessages = withTenantEncryptedDb;
