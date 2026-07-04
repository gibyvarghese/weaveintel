/**
 * Example 15 — Tenant Encryption Phase 4.
 *
 * Demonstrates the reusable `weaveTenantEncryptedProxy` helper from
 * `@weaveintel/encryption` against a tiny in-memory two-table adapter
 * (messages + chats). Verifies the four Phase 4 invariants:
 *
 *   1. Multi-table coverage: a single proxy call covers BOTH tables via a
 *      declarative `methods` spec map.
 *   2. Idempotent re-write: passing an already-encrypted sentinel through
 *      a write does not double-encrypt.
 *   3. Lazy-upgrade tolerance: rows written before encryption was enabled
 *      stay readable after enabling.
 *   4. Cross-epoch read after `rotateDek`: ciphertext encrypted under the
 *      old DEK is still decryptable, while new writes use the new epoch.
 *   5. Kill-switch: turning the policy `enabled=false` pauses NEW writes
 *      (plaintext stored) while old reads still decrypt.
 *
 * Run: npx tsx examples/15-encryption-phase4.ts
 */

import {
  LocalKmsProvider,
  loadMasterKeyFromEnv,
  noopAuditEmitter,
  weaveTenantKeyManager,
  weaveTenantEncryptedProxy,
  isEncrypted,
  type BikRecord,
  type DekRecord,
  type EncryptedMethodSpec,
  type EncryptionStore,
  type FieldPolicy,
  type KekRecord,
  type TenantPolicyRecord,
  type TenantPolicySnapshot,
} from '@weaveintel/encryption';

// ─── Tiny in-memory EncryptionStore ────────────────────────────────────
function createInMemoryStore(): EncryptionStore {
  const policies = new Map<string, TenantPolicyRecord>();
  const keks: KekRecord[] = [];
  const deks: DekRecord[] = [];
  const biks: BikRecord[] = [];
  return {
    async getPolicy(t) {
      return policies.get(t) ?? null;
    },
    async upsertPolicy(p) {
      policies.set(p.tenantId, p);
    },
    async listKeks(t) {
      return keks.filter((k) => k.tenantId === t);
    },
    async insertKek(k) {
      keks.push(k);
    },
    async updateKekStatus(id, status, at) {
      const r = keks.find((k) => k.id === id);
      if (!r) return;
      Object.assign(r, { status, ...(status === 'previous' ? { rotatedAt: at } : status === 'revoked' ? { revokedAt: at } : {}) });
    },
    async getKekById(t, kekId) {
      return keks.find((k) => k.tenantId === t && k.id === kekId) ?? null;
    },
    async listDeks(t) {
      return deks.filter((d) => d.tenantId === t);
    },
    async insertDek(d) {
      deks.push(d);
    },
    async updateDekStatus(id, status, at) {
      const r = deks.find((d) => d.id === id);
      if (!r) return;
      Object.assign(r, { status, ...(status === 'previous' ? { rotatedAt: at } : status === 'revoked' ? { revokedAt: at } : {}) });
    },
    async getDekById(t, dekId) {
      return deks.find((d) => d.tenantId === t && d.id === dekId) ?? null;
    },
    async getMaxDekEpoch(t) {
      const epochs = deks.filter((d) => d.tenantId === t && d.status === 'active').map((d) => d.epoch);
      return epochs.length ? Math.max(...epochs) : null;
    },
    async listBiks(t) {
      return biks.filter((b) => b.tenantId === t);
    },
    async insertBik(b) {
      biks.push(b);
    },
    async updateBikStatus(id, status, at) {
      const r = biks.find((b) => b.id === id);
      if (!r) return;
      Object.assign(r, { status, revokedAt: at });
    },
    async deletePolicy(t) {
      policies.delete(t);
    },
    async deleteAllWrappedMaterial(t) {
      const counts = {
        keks: keks.filter((k) => k.tenantId === t).length,
        deks: deks.filter((d) => d.tenantId === t).length,
        biks: biks.filter((b) => b.tenantId === t).length,
      };
      for (let i = keks.length - 1; i >= 0; i--) if (keks[i].tenantId === t) keks.splice(i, 1);
      for (let i = deks.length - 1; i >= 0; i--) if (deks[i].tenantId === t) deks.splice(i, 1);
      for (let i = biks.length - 1; i >= 0; i--) if (biks[i].tenantId === t) biks.splice(i, 1);
      return counts;
    },
  };
}

// ─── Tiny in-memory two-table app DB (messages + chats) ────────────────
interface ChatRow {
  id: string;
  user_id: string;
  title: string;
}
interface MessageRow {
  id: string;
  chat_id: string;
  content: string;
  metadata: string;
}

interface AppDb {
  // chats
  insertChat(row: ChatRow): Promise<void>;
  getChat(id: string): Promise<ChatRow | null>;
  // messages
  insertMessage(row: MessageRow): Promise<void>;
  listMessages(chatId: string): Promise<MessageRow[]>;
  // tenant resolution helpers
  getUserTenant(userId: string): string | null;
  setUserTenant(userId: string, tenantId: string): void;
}

function createAppDb(): { app: AppDb; raw: { chats: Map<string, ChatRow>; messages: MessageRow[] } } {
  const chats = new Map<string, ChatRow>();
  const messages: MessageRow[] = [];
  const userTenants = new Map<string, string>();
  const app: AppDb = {
    async insertChat(row) {
      chats.set(row.id, { ...row });
    },
    async getChat(id) {
      const r = chats.get(id);
      return r ? { ...r } : null;
    },
    async insertMessage(row) {
      messages.push({ ...row });
    },
    async listMessages(chatId) {
      return messages.filter((m) => m.chat_id === chatId).map((m) => ({ ...m }));
    },
    getUserTenant(uid) {
      return userTenants.get(uid) ?? null;
    },
    setUserTenant(uid, tid) {
      userTenants.set(uid, tid);
    },
  };
  return { app, raw: { chats, messages } };
}

async function main(): Promise<void> {
  console.log('--- Tenant Encryption Phase 4 demo (multi-table proxy) ---\n');

  // 1. Bootstrap key manager + tenant.
  const loaded = loadMasterKeyFromEnv({ devGenerateIfMissing: true });
  const store = createInMemoryStore();
  const kms = new LocalKmsProvider({ masterKey: loaded.key });
  const km = weaveTenantKeyManager({ store, kms, audit: noopAuditEmitter });
  const tenantId = 'demo-tenant';
  await km.bootstrapTenant({ tenantId, enable: true, actor: 'example-15' });

  // 2. Build the in-memory app DB and seed a user→tenant mapping.
  const { app, raw } = createAppDb();
  app.setUserTenant('user-1', tenantId);

  // 3. Operator-controlled policy (mirrors what an admin row would carry).
  let policyEnabled = true;
  const fieldPolicy: FieldPolicy = {
    chats: { columns: ['title'] },
    messages: { columns: ['content', 'metadata'] },
  };
  const loadTenantPolicy = async (): Promise<TenantPolicySnapshot | null> => ({
    enabled: policyEnabled,
    fieldPolicy,
  });

  // 4. Declarative per-method spec — single Proxy call covers both tables.
  const methods: Record<string, EncryptedMethodSpec> = {
    insertChat: {
      kind: 'write',
      table: 'chats',
      tenant: async (args) => app.getUserTenant((args[0] as ChatRow).user_id),
      rowId: (args) => (args[0] as ChatRow).id,
      tenantCacheKey: (args) => `user:${(args[0] as ChatRow).user_id}`,
      columns: [
        { column: 'title', get: (t) => (t as ChatRow).title, set: (t, v) => { (t as ChatRow).title = v ?? ''; } },
      ],
    },
    getChat: {
      kind: 'read',
      table: 'chats',
      shape: 'single',
      tenant: async (row) => app.getUserTenant((row as ChatRow).user_id),
      rowId: (row) => (row as ChatRow).id,
      tenantCacheKey: (row) => `user:${(row as ChatRow).user_id}`,
      columns: [
        { column: 'title', get: (t) => (t as ChatRow).title, set: (t, v) => { (t as ChatRow).title = v ?? ''; } },
      ],
    },
    insertMessage: {
      kind: 'write',
      table: 'messages',
      tenant: async (args, rdb) => {
        const m = args[0] as MessageRow;
        const c = await (rdb as AppDb).getChat(m.chat_id);
        return c ? app.getUserTenant(c.user_id) : null;
      },
      rowId: (args) => (args[0] as MessageRow).id,
      tenantCacheKey: (args) => `chat:${(args[0] as MessageRow).chat_id}`,
      columns: [
        { column: 'content', get: (t) => (t as MessageRow).content, set: (t, v) => { (t as MessageRow).content = v ?? ''; } },
        { column: 'metadata', get: (t) => (t as MessageRow).metadata, set: (t, v) => { (t as MessageRow).metadata = v ?? ''; } },
      ],
    },
    listMessages: {
      kind: 'read',
      table: 'messages',
      shape: 'list',
      tenant: async (row, _args, rdb) => {
        const m = row as MessageRow;
        const c = await (rdb as AppDb).getChat(m.chat_id);
        return c ? app.getUserTenant(c.user_id) : null;
      },
      rowId: (row) => (row as MessageRow).id,
      tenantCacheKey: (row) => `chat:${(row as MessageRow).chat_id}`,
      columns: [
        { column: 'content', get: (t) => (t as MessageRow).content, set: (t, v) => { (t as MessageRow).content = v ?? ''; } },
        { column: 'metadata', get: (t) => (t as MessageRow).metadata, set: (t, v) => { (t as MessageRow).metadata = v ?? ''; } },
      ],
    },
  };

  let manager: typeof km | null = km;
  const wrapped = weaveTenantEncryptedProxy<AppDb>(app, {
    getManager: () => manager,
    loadTenantPolicy,
    methods,
  });

  // ── Invariant 1 — multi-table: insert one chat + one message via wrapped DB
  await wrapped.insertChat({ id: 'chat-1', user_id: 'user-1', title: 'Project Atlas' });
  await wrapped.insertMessage({
    id: 'msg-1',
    chat_id: 'chat-1',
    content: 'Atlas Q4 planning kickoff.',
    metadata: '{"role":"user"}',
  });

  const rawChat = raw.chats.get('chat-1')!;
  const rawMsg = raw.messages.find((m) => m.id === 'msg-1')!;
  if (!isEncrypted(rawChat.title)) throw new Error('chats.title not encrypted at rest');
  if (!isEncrypted(rawMsg.content)) throw new Error('messages.content not encrypted at rest');
  if (!isEncrypted(rawMsg.metadata)) throw new Error('messages.metadata not encrypted at rest');
  console.log(`[multi-table] chat.title sentinel:    ${rawChat.title.slice(0, 28)}...`);
  console.log(`[multi-table] msg.content sentinel:   ${rawMsg.content.slice(0, 28)}...`);
  console.log(`[multi-table] msg.metadata sentinel:  ${rawMsg.metadata.slice(0, 28)}...`);

  const readChat = await wrapped.getChat('chat-1');
  const readMsgs = await wrapped.listMessages('chat-1');
  if (readChat?.title !== 'Project Atlas') throw new Error('chats.title round-trip failed');
  if (readMsgs[0]?.content !== 'Atlas Q4 planning kickoff.') throw new Error('messages.content round-trip failed');
  console.log(`[round-trip]  chat.title="${readChat.title}" msg.content="${readMsgs[0]!.content}"`);

  // ── Invariant 2 — idempotent re-write: passing existing sentinel back
  //    through insertMessage must NOT re-encrypt (no nested enc:v1:enc:v1:...).
  const existingSentinel = rawMsg.content;
  await wrapped.insertMessage({
    id: 'msg-1-rewrite',
    chat_id: 'chat-1',
    content: existingSentinel, // already a sentinel
    metadata: '{"replay":true}',
  });
  const rewrite = raw.messages.find((m) => m.id === 'msg-1-rewrite')!;
  if (rewrite.content !== existingSentinel) {
    throw new Error('idempotent re-write violated — sentinel was re-encrypted');
  }
  console.log('[idempotent]  passing an existing sentinel through write left it unchanged');

  // ── Invariant 5 — kill-switch: disable policy, new writes are plaintext,
  //    old reads still decrypt.
  policyEnabled = false;
  await wrapped.insertChat({ id: 'chat-2', user_id: 'user-1', title: 'After kill-switch' });
  const ks = raw.chats.get('chat-2')!;
  if (isEncrypted(ks.title)) throw new Error('kill-switch: new write should be plaintext');
  console.log(`[kill-switch] new chat plaintext at rest: title="${ks.title}"`);

  const stillReadable = await wrapped.getChat('chat-1');
  if (stillReadable?.title !== 'Project Atlas') throw new Error('kill-switch broke old reads');
  console.log(`[kill-switch] old chat still decrypts:    title="${stillReadable.title}"`);

  // Re-enable for the rotation invariant.
  policyEnabled = true;

  // ── Invariant 3 — lazy-upgrade tolerance: pretend chat-2 was legacy
  //    plaintext written by some earlier code path; reads should pass it
  //    through untouched (no decrypt attempt, no throw).
  const legacy = await wrapped.getChat('chat-2');
  if (legacy?.title !== 'After kill-switch') throw new Error('lazy-upgrade: plaintext read corrupted');
  console.log(`[lazy-upgrade] plaintext row read untouched: title="${legacy.title}"`);

  // ── Invariant 4 — cross-epoch read after rotateDek.
  const oldEpochSentinel = rawMsg.content;
  const newDek = await km.rotateDek(tenantId, 'example-15');
  await wrapped.insertMessage({
    id: 'msg-2',
    chat_id: 'chat-1',
    content: 'Post-rotation message.',
    metadata: '{"role":"user"}',
  });
  const postMsg = raw.messages.find((m) => m.id === 'msg-2')!;
  const newEpoch = postMsg.content.split(':')[2];
  const oldEpoch = oldEpochSentinel.split(':')[2];
  if (Number(newEpoch) !== newDek.epoch) {
    throw new Error(`expected new ct epoch=${newDek.epoch} got ${newEpoch}`);
  }
  if (newEpoch === oldEpoch) {
    throw new Error('epoch did not advance after rotateDek');
  }
  console.log(`[rotate-dek]  old-epoch=${oldEpoch} new-epoch=${newEpoch}`);

  const allMsgs = await wrapped.listMessages('chat-1');
  const m1 = allMsgs.find((m) => m.id === 'msg-1');
  const m2 = allMsgs.find((m) => m.id === 'msg-2');
  if (m1?.content !== 'Atlas Q4 planning kickoff.') throw new Error('cross-epoch: old msg failed to decrypt');
  if (m2?.content !== 'Post-rotation message.') throw new Error('cross-epoch: new msg failed to decrypt');
  console.log('[cross-epoch] old + new ciphertexts decrypted in a single list call');

  // ── Bonus — manager kill-switch (getManager() → null) yields graceful
  //    plaintext writes, no throw.
  manager = null;
  await wrapped.insertChat({ id: 'chat-3', user_id: 'user-1', title: 'No manager available' });
  const noMgr = raw.chats.get('chat-3')!;
  if (isEncrypted(noMgr.title)) throw new Error('manager-null: should have stored plaintext');
  console.log(`[no-manager]  graceful plaintext write: title="${noMgr.title}"`);

  console.log('\n--- All Phase 4 invariants verified. ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
