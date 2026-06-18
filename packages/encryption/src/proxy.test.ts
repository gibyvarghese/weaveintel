import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { weaveTenantKeyManager, type TenantKeyManager } from './key-manager.js';
import { LocalKmsProvider } from './providers/local.js';
import { isEncrypted } from './envelope.js';
import {
  weaveTenantEncryptedProxy,
  type EncryptedAdapterOptions,
  type TenantPolicySnapshot,
} from './proxy.js';
import type {
  BikRecord,
  DekRecord,
  EncryptionStore,
  KekRecord,
  KeyStatus,
  TenantPolicyRecord,
} from './store.js';

class InMemoryStore implements EncryptionStore {
  policy: TenantPolicyRecord | null = null;
  keks: KekRecord[] = [];
  deks: DekRecord[] = [];
  biks: BikRecord[] = [];
  async getPolicy() { return this.policy; }
  async upsertPolicy(p: TenantPolicyRecord) { this.policy = p; }
  async listKeks() { return [...this.keks]; }
  async insertKek(k: KekRecord) { this.keks.push(k); }
  async updateKekStatus(id: string, s: KeyStatus, ts: number) {
    this.keks = this.keks.map((k) =>
      k.id === id ? { ...k, status: s, rotatedAt: s === 'previous' ? ts : k.rotatedAt, revokedAt: s === 'revoked' ? ts : k.revokedAt } : k);
  }

  async getKekById(_t: string, id: string) { return this.keks.find((k) => k.id === id) ?? null; }
  async listDeks() { return [...this.deks]; }
  async insertDek(d: DekRecord) { this.deks.push(d); }
  async updateDekStatus(id: string, s: KeyStatus, ts: number) {
    this.deks = this.deks.map((d) =>
      d.id === id ? { ...d, status: s, rotatedAt: s === 'previous' ? ts : d.rotatedAt, revokedAt: s === 'revoked' ? ts : d.revokedAt } : d);
  }

  async getDekById(_t: string, id: string) { return this.deks.find((d) => d.id === id) ?? null; }
  async getMaxDekEpoch(_t: string) {
    const active = this.deks.filter((d) => d.status === 'active');
    return active.length ? Math.max(...active.map((d) => d.epoch)) : null;
  }
  async listBiks() { return [...this.biks]; }
  async insertBik(b: BikRecord) { this.biks.push(b); }
  async updateBikStatus(id: string, s: KeyStatus, ts: number) {
    this.biks = this.biks.map((b) =>
      b.id === id ? { ...b, status: s, revokedAt: s === 'revoked' ? ts : b.revokedAt } : b);
  }
  async deletePolicy() { this.policy = null; }
  async deleteAllWrappedMaterial() {
    const counts = { keks: this.keks.length, deks: this.deks.length, biks: this.biks.length };
    this.keks = []; this.deks = []; this.biks = [];
    return counts;
  }
}

async function makeReadyManager(tenantId = 'tenant-a'): Promise<TenantKeyManager> {
  const store = new InMemoryStore();
  const kms = new LocalKmsProvider({ masterKey: randomBytes(32) });
  const km = weaveTenantKeyManager({ store, kms });
  await km.bootstrapTenant({ tenantId, enable: true });
  return km;
}

// ─── Test fixture: a stub multi-table adapter ────────────────────────────
interface MessageRow { id: string; chat_id: string; content: string | null; metadata: string | null; }
interface ChatRow { id: string; user_id: string; title: string | null; }

class StubAdapter {
  messages: MessageRow[] = [];
  chats: ChatRow[] = [];
  // user_id → tenant_id
  users: Record<string, string> = { 'user-1': 'tenant-a', 'user-2': 'tenant-b' };

  async addMessage(row: MessageRow): Promise<MessageRow> {
    this.messages.push(row);
    return row;
  }
  async getMessage(id: string): Promise<MessageRow | null> {
    return this.messages.find((m) => m.id === id) ?? null;
  }
  async listMessages(chatId: string): Promise<MessageRow[]> {
    return this.messages.filter((m) => m.chat_id === chatId);
  }
  async createChat(row: ChatRow): Promise<ChatRow> {
    this.chats.push(row);
    return row;
  }
  async getChat(id: string): Promise<ChatRow | null> {
    return this.chats.find((c) => c.id === id) ?? null;
  }
  async getChatTenant(chatId: string): Promise<string | null> {
    const chat = this.chats.find((c) => c.id === chatId);
    if (!chat) return null;
    return this.users[chat.user_id] ?? null;
  }
  async getUserTenant(userId: string): Promise<string | null> {
    return this.users[userId] ?? null;
  }
  // Methods that should pass through untouched.
  async ping(): Promise<string> { return 'pong'; }
}

function makeProxy(
  raw: StubAdapter,
  manager: TenantKeyManager | null,
  policy: TenantPolicySnapshot | null,
  resolverCounter?: { count: number },
) {
  const opts: EncryptedAdapterOptions = {
    getManager: () => manager,
    loadTenantPolicy: async (_db, _tid) => policy,
    methods: {
      addMessage: {
        kind: 'write',
        table: 'messages',
        tenant: async (args, db) => {
          if (resolverCounter) resolverCounter.count += 1;
          const row = args[0] as MessageRow;
          return (db as StubAdapter).getChatTenant(row.chat_id);
        },
        rowId: (args) => (args[0] as MessageRow).id,
        tenantCacheKey: (args) => `chat:${(args[0] as MessageRow).chat_id}`,
        columns: [
          { column: 'content', get: (t) => (t as MessageRow).content, set: (t, v) => { (t as MessageRow).content = v ?? null; } },
          { column: 'metadata', get: (t) => (t as MessageRow).metadata, set: (t, v) => { (t as MessageRow).metadata = v ?? null; } },
        ],
      },
      getMessage: {
        kind: 'read',
        table: 'messages',
        shape: 'single',
        tenant: async (row, _args, db) => (db as StubAdapter).getChatTenant((row as MessageRow).chat_id),
        rowId: (row) => (row as MessageRow).id,
        tenantCacheKey: (row) => `chat:${(row as MessageRow).chat_id}`,
        columns: [
          { column: 'content', get: (t) => (t as MessageRow).content, set: (t, v) => { (t as MessageRow).content = v ?? null; } },
          { column: 'metadata', get: (t) => (t as MessageRow).metadata, set: (t, v) => { (t as MessageRow).metadata = v ?? null; } },
        ],
      },
      listMessages: {
        kind: 'read',
        table: 'messages',
        shape: 'list',
        tenant: async (row, _args, db) => (db as StubAdapter).getChatTenant((row as MessageRow).chat_id),
        rowId: (row) => (row as MessageRow).id,
        tenantCacheKey: (row) => `chat:${(row as MessageRow).chat_id}`,
        columns: [
          { column: 'content', get: (t) => (t as MessageRow).content, set: (t, v) => { (t as MessageRow).content = v ?? null; } },
        ],
      },
      createChat: {
        kind: 'write',
        table: 'chats',
        tenant: async (args, db) => (db as StubAdapter).getUserTenant((args[0] as ChatRow).user_id),
        rowId: (args) => (args[0] as ChatRow).id,
        tenantCacheKey: (args) => `user:${(args[0] as ChatRow).user_id}`,
        columns: [
          { column: 'title', get: (t) => (t as ChatRow).title, set: (t, v) => { (t as ChatRow).title = v ?? null; } },
        ],
      },
      getChat: {
        kind: 'read',
        table: 'chats',
        shape: 'single',
        tenant: async (row, _args, db) => (db as StubAdapter).getUserTenant((row as ChatRow).user_id),
        rowId: (row) => (row as ChatRow).id,
        columns: [
          { column: 'title', get: (t) => (t as ChatRow).title, set: (t, v) => { (t as ChatRow).title = v ?? null; } },
        ],
      },
    },
  };
  return weaveTenantEncryptedProxy(raw, opts);
}

const FULL_POLICY: TenantPolicySnapshot = {
  enabled: true,
  fieldPolicy: {
    messages: { columns: ['content', 'metadata'] },
    chats: { columns: ['title'] },
  },
};

describe('weaveTenantEncryptedProxy', () => {
  it('encrypts on write and decrypts on read across tables', async () => {
    const km = await makeReadyManager('tenant-a');
    const raw = new StubAdapter();
    const proxy = makeProxy(raw, km, FULL_POLICY);

    await proxy.createChat({ id: 'chat-1', user_id: 'user-1', title: 'My Chat' });
    await proxy.addMessage({ id: 'msg-1', chat_id: 'chat-1', content: 'hello', metadata: '{"k":1}' });

    // Raw rows are encrypted at rest.
    expect(isEncrypted(raw.chats[0]!.title!)).toBe(true);
    expect(isEncrypted(raw.messages[0]!.content!)).toBe(true);
    expect(isEncrypted(raw.messages[0]!.metadata!)).toBe(true);

    // Reads transparently decrypt.
    const chat = await proxy.getChat('chat-1');
    const msg = await proxy.getMessage('msg-1');
    expect(chat?.title).toBe('My Chat');
    expect(msg?.content).toBe('hello');
    expect(msg?.metadata).toBe('{"k":1}');
  });

  it('passes through writes verbatim when manager is null', async () => {
    const raw = new StubAdapter();
    const proxy = makeProxy(raw, null, FULL_POLICY);
    await proxy.createChat({ id: 'chat-1', user_id: 'user-1', title: 'plain' });
    expect(raw.chats[0]!.title).toBe('plain');
    expect(isEncrypted(raw.chats[0]!.title!)).toBe(false);
  });

  it('passes through writes when policy.enabled is false', async () => {
    const km = await makeReadyManager('tenant-a');
    const raw = new StubAdapter();
    const proxy = makeProxy(raw, km, { enabled: false, fieldPolicy: FULL_POLICY.fieldPolicy });
    await proxy.createChat({ id: 'chat-1', user_id: 'user-1', title: 'plain' });
    expect(raw.chats[0]!.title).toBe('plain');
  });

  it('passes through writes when (table,column) not in field policy', async () => {
    const km = await makeReadyManager('tenant-a');
    const raw = new StubAdapter();
    const proxy = makeProxy(raw, km, { enabled: true, fieldPolicy: { messages: { columns: ['content'] } } });
    await proxy.addMessage({ id: 'msg-1', chat_id: 'chat-1', content: 'secret', metadata: '{"k":1}' });
    // user-1 maps to tenant-a, but chat-1 does not exist so getChatTenant returns null → pass-through.
    expect(raw.messages[0]!.content).toBe('secret');
  });

  it('does not double-wrap an already-encrypted value on re-write', async () => {
    const km = await makeReadyManager('tenant-a');
    const raw = new StubAdapter();
    const proxy = makeProxy(raw, km, FULL_POLICY);
    await proxy.createChat({ id: 'chat-1', user_id: 'user-1', title: 'first' });
    const sentinel = raw.chats[0]!.title!;
    expect(isEncrypted(sentinel)).toBe(true);
    // Write the same row again with the sentinel as input — must not re-encrypt.
    raw.chats = [];
    await proxy.createChat({ id: 'chat-1', user_id: 'user-1', title: sentinel });
    expect(raw.chats[0]!.title).toBe(sentinel);
  });

  it('tolerates plaintext on read (lazy-upgrade)', async () => {
    const km = await makeReadyManager('tenant-a');
    const raw = new StubAdapter();
    raw.chats.push({ id: 'chat-1', user_id: 'user-1', title: 'legacy plaintext' });
    const proxy = makeProxy(raw, km, FULL_POLICY);
    const chat = await proxy.getChat('chat-1');
    expect(chat?.title).toBe('legacy plaintext');
  });

  it('does not mutate caller args', async () => {
    const km = await makeReadyManager('tenant-a');
    const raw = new StubAdapter();
    const proxy = makeProxy(raw, km, FULL_POLICY);
    const original = { id: 'chat-1', user_id: 'user-1', title: 'private' };
    await proxy.createChat(original);
    expect(original.title).toBe('private');
    expect(isEncrypted(raw.chats[0]!.title!)).toBe(true);
  });

  it('caches tenant resolution per cache key across writes', async () => {
    const km = await makeReadyManager('tenant-a');
    const raw = new StubAdapter();
    raw.chats.push({ id: 'chat-1', user_id: 'user-1', title: 'precreated' });
    const counter = { count: 0 };
    const proxy = makeProxy(raw, km, FULL_POLICY, counter);
    await proxy.addMessage({ id: 'm1', chat_id: 'chat-1', content: 'a', metadata: null });
    await proxy.addMessage({ id: 'm2', chat_id: 'chat-1', content: 'b', metadata: null });
    await proxy.addMessage({ id: 'm3', chat_id: 'chat-1', content: 'c', metadata: null });
    expect(counter.count).toBe(1);
  });

  it('decrypts a list result and tolerates per-row tenant resolution failure', async () => {
    const km = await makeReadyManager('tenant-a');
    const raw = new StubAdapter();
    raw.chats.push({ id: 'chat-1', user_id: 'user-1', title: 'x' });
    const proxy = makeProxy(raw, km, FULL_POLICY);
    await proxy.addMessage({ id: 'm1', chat_id: 'chat-1', content: 'one', metadata: null });
    await proxy.addMessage({ id: 'm2', chat_id: 'chat-1', content: 'two', metadata: null });
    // Inject an orphan row whose chat_id doesn't resolve to a tenant.
    raw.messages.push({ id: 'm3', chat_id: 'chat-missing', content: 'orphan-plaintext', metadata: null });
    const list = await proxy.listMessages('chat-1');
    const orphan = await proxy.listMessages('chat-missing');
    expect(list.map((m) => m.content)).toEqual(['one', 'two']);
    expect(orphan[0]!.content).toBe('orphan-plaintext');
  });

  it('passes through methods not listed in the spec', async () => {
    const km = await makeReadyManager('tenant-a');
    const raw = new StubAdapter();
    const proxy = makeProxy(raw, km, FULL_POLICY);
    expect(await proxy.ping()).toBe('pong');
  });
});
