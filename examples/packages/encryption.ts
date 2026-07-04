/**
 * Example: Encryption
 *
 * Demonstrates every major surface of @weaveintel/encryption with zero
 * external dependencies. All keys live in process memory; no cloud KMS,
 * no database, no API keys required.
 *
 * ─── The problem this package solves ────────────────────────────────────────
 * Multi-tenant AI applications store user messages, PII, and agent outputs in
 * a shared database. A single compromised DB dump should not expose any
 * tenant's data. @weaveintel/encryption solves this with per-tenant AES-256-GCM
 * envelope encryption:
 *
 *   Root master key (in KMS / env var) wraps per-tenant KEKs
 *   KEK (Key Encryption Key) wraps per-tenant DEKs
 *   DEK (Data Encryption Key) encrypts individual field values
 *
 * This three-level hierarchy means rotating a DEK only re-wraps one small key,
 * not all data. Revoking a tenant's KEK permanently destroys access to all
 * their ciphertext without touching other tenants.
 *
 * ─── Packages used ──────────────────────────────────────────────────────────
 *   @weaveintel/encryption
 *     • LocalKmsProvider        — in-process KMS using a 32-byte master key
 *     • weaveTenantKeyManager   — per-tenant orchestrator (bootstrap, encrypt,
 *                                  decrypt, rotate, computeBlindIndex, shred)
 *     • maybeEncryptField       — adapter-layer helper: encrypt on write
 *     • maybeDecryptField       — adapter-layer helper: decrypt on read
 *     • maybeBlindIndex         — adapter-layer helper: HMAC lookup index
 *     • isFieldEncrypted        — check whether (table, column) is in policy
 *     • DEFAULT_FIELD_POLICY    — built-in policy covering PII tables
 *     • DEFAULT_BLIND_INDEX_SPECS — default specs for blind-indexed columns
 *     • InMemoryMetricsEmitter  — collect encrypt/decrypt/KMS metrics
 *     • InMemoryRewriteJobStore — in-memory job store for DEK rewrite scheduler
 *     • noopAuditEmitter        — discard audit events (swap for real emitter)
 *     • isEncrypted             — detect the enc:v1: sentinel prefix
 *
 * ─── Local helpers (NOT from any @weaveintel package) ───────────────────────
 *   InMemoryEncryptionStore — implements EncryptionStore over plain JS arrays.
 *     This is a local demo utility. In production you wire geneweave's SQLite
 *     adapter (or your own Postgres/Mongo adapter) which persists KEK/DEK
 *     records durably. The package never ships a bundled store implementation
 *     because store choice is a host concern.
 *
 *   header() / ok() / section() / info() — console formatting helpers.
 *     Not from any package; replace with your own logging in production.
 *
 *   CapturingAudit — collects audit events in an array for assertion.
 *     In production this writes to an encryption_audit table.
 *
 * Run: npx tsx examples/packages/encryption.ts
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import {
  LocalKmsProvider,
  weaveTenantKeyManager,
  noopAuditEmitter,
  InMemoryMetricsEmitter,
  InMemoryRewriteJobStore,
  DEFAULT_FIELD_POLICY,
  DEFAULT_BLIND_INDEX_SPECS,
  isFieldEncrypted,
  maybeEncryptField,
  maybeDecryptField,
  maybeBlindIndex,
  isEncrypted,
  type EncryptionStore,
  type TenantPolicyRecord,
  type KekRecord,
  type DekRecord,
  type BikRecord,
  type KeyStatus,
  type TenantEncryptionState,
  type BlindIndexState,
  type AuditEmitter,
  type EncryptionAuditEvent,
} from '@weaveintel/encryption';

/* ─── Console helpers (LOCAL — not from any package) ────────────────────── */
// Pure display utilities. In production use your logging library instead.

const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const GREEN = '\x1b[32m';
const CYAN  = '\x1b[36m';
const DIM   = '\x1b[2m';

function header(title: string) {
  console.log(`\n${BOLD}${'═'.repeat(64)}${RESET}`);
  console.log(`${BOLD}  ${title}${RESET}`);
  console.log(`${BOLD}${'═'.repeat(64)}${RESET}`);
}

function section(title: string) {
  console.log(`\n${CYAN}  ── ${title} ──${RESET}`);
}

function ok(msg: string)   { console.log(`${GREEN}  ✓${RESET} ${msg}`); }
function info(msg: string) { console.log(`${DIM}  ℹ ${msg}${RESET}`); }

/* ─── InMemoryEncryptionStore (LOCAL — not from any package) ────────────── */
// The package defines the EncryptionStore interface but does not ship a
// bundled implementation — hosts provide their own (SQLite / Postgres / etc.).
// This in-memory implementation satisfies the interface for running this example.
// In production, geneweave's SQLite adapter implements the same interface.

class InMemoryEncryptionStore implements EncryptionStore {
  policy: TenantPolicyRecord | null = null;
  keks: KekRecord[] = [];
  deks: DekRecord[] = [];
  biks: BikRecord[] = [];

  async getPolicy(_t: string)          { return this.policy; }
  async upsertPolicy(p: TenantPolicyRecord) { this.policy = p; }

  async listKeks()   { return [...this.keks]; }
  async insertKek(k: KekRecord) { this.keks.push(k); }
  async updateKekStatus(id: string, s: KeyStatus, ts: number) {
    this.keks = this.keks.map(k =>
      k.id === id
        ? { ...k, status: s, rotatedAt: s === 'previous' ? ts : k.rotatedAt, revokedAt: s === 'revoked' ? ts : k.revokedAt }
        : k,
    );
  }
  async getKekById(tenantId: string, kekId: string) {
    return this.keks.find(k => k.tenantId === tenantId && k.id === kekId) ?? null;
  }

  async listDeks()   { return [...this.deks]; }
  async insertDek(d: DekRecord) { this.deks.push(d); }
  async updateDekStatus(id: string, s: KeyStatus, ts: number) {
    this.deks = this.deks.map(d =>
      d.id === id
        ? { ...d, status: s, rotatedAt: s === 'previous' ? ts : d.rotatedAt, revokedAt: s === 'revoked' ? ts : d.revokedAt }
        : d,
    );
  }
  async getDekById(tenantId: string, dekId: string) {
    return this.deks.find(d => d.tenantId === tenantId && d.id === dekId) ?? null;
  }
  async getMaxDekEpoch(tenantId: string) {
    const epochs = this.deks
      .filter(d => d.tenantId === tenantId && d.status === 'active')
      .map(d => d.epoch);
    return epochs.length ? Math.max(...epochs) : null;
  }

  async listBiks()   { return [...this.biks]; }
  async insertBik(b: BikRecord) { this.biks.push(b); }
  async updateBikStatus(id: string, s: KeyStatus, ts: number) {
    this.biks = this.biks.map(b =>
      b.id === id
        ? { ...b, status: s, revokedAt: s === 'revoked' ? ts : b.revokedAt }
        : b,
    );
  }

  async deletePolicy()                   { this.policy = null; }
  async deleteAllWrappedMaterial() {
    const counts = { keks: this.keks.length, deks: this.deks.length, biks: this.biks.length };
    this.keks = []; this.deks = []; this.biks = [];
    return counts;
  }
}

/* ─── CapturingAudit (LOCAL — not from any package) ────────────────────── */
// Collects audit events in memory for assertions. In production, wire to an
// append-only encryption_audit table for compliance (GDPR, SOC 2, etc.).

class CapturingAudit implements AuditEmitter {
  readonly events: EncryptionAuditEvent[] = [];
  async emit(e: EncryptionAuditEvent) { this.events.push(e); }
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  MAIN                                                                       */
/* ══════════════════════════════════════════════════════════════════════════ */

async function main() {
  header('WeaveIntel Encryption — Complete Package Example');

  /* ────────────────────────────────────────────────────────────────────────
   * 1. LocalKmsProvider
   *
   * LocalKmsProvider is the simplest KMS backend: it wraps tenant KEKs under
   * a single in-process 32-byte master key using AES-256-GCM.
   *
   * In production you point this at AWS KMS, Azure Key Vault, or GCP KMS
   * instead — all implement the same KmsProvider interface. The master key is
   * usually loaded from WEAVE_ENCRYPTION_MASTER_KEY (hex or base64).
   *
   * Here we generate a random key for the example so no env var is needed.
   * ────────────────────────────────────────────────────────────────────────*/
  section('1 — LocalKmsProvider (in-process AES-256-GCM KMS)');

  // Generate a random 32-byte master key. In production this comes from a
  // secure secret store (environment variable, Vault, etc.).
  const masterKey = randomBytes(32);

  // LocalKmsProvider wraps each tenant's KEK under this master key so the raw
  // tenant key material is never stored — only its AES-GCM-encrypted form.
  const kms = new LocalKmsProvider({ masterKey });

  // rootKeyId() is async — it identifies which root key wraps a tenant's KEK.
  // For LocalKmsProvider this is always 'local:default'.
  const rootId = await kms.rootKeyId('any-tenant');
  ok(`LocalKmsProvider created — root key ID: ${rootId}`);

  /* ────────────────────────────────────────────────────────────────────────
   * 2. TenantKeyManager — bootstrap a tenant
   *
   * weaveTenantKeyManager creates the per-tenant orchestrator. It manages:
   *   • KEK lifecycle (create, rotate, revoke)
   *   • DEK lifecycle (create, rotate, revoke)
   *   • BIK (Blind Index Key) lifecycle
   *   • Encrypt / decrypt individual field values
   *   • computeBlindIndex for searchable encrypted fields
   *   • GDPR hard-shred (delete all wrapped key material)
   *
   * The manager is stateless across tenants — one instance serves all of them.
   * ────────────────────────────────────────────────────────────────────────*/
  section('2 — TenantKeyManager — bootstrap a tenant');

  const store   = new InMemoryEncryptionStore();
  const audit   = new CapturingAudit();

  // InMemoryMetricsEmitter collects encrypt/decrypt/KMS counters in memory.
  // Wire this to Prometheus, Datadog, or your OTel pipeline in production.
  const metrics = new InMemoryMetricsEmitter();

  const km = weaveTenantKeyManager({
    store,
    kms,
    audit,   // Receives an event for every key lifecycle operation
    metrics, // Receives a metric record for every crypto call
  });

  const TENANT = 'acme-corp';

  // bootstrapTenant provisions:
  //   1. A KEK wrapped under the root master key (stored in EncryptionStore)
  //   2. A DEK wrapped under the KEK
  //   3. A BIK (Blind Index Key) wrapped under the KEK
  //   4. A TenantPolicyRecord recording all active key IDs
  const policy = await km.bootstrapTenant({ tenantId: TENANT, enable: true });

  assert.equal(policy.enabled, true, 'encryption should be enabled');
  assert.ok(policy.activeKekId, 'should have an active KEK');
  assert.ok(policy.activeDekId, 'should have an active DEK');

  ok(`Tenant "${TENANT}" bootstrapped — KEK: ${policy.activeKekId!.slice(0, 8)}…`);
  ok(`Active DEK: ${policy.activeDekId!.slice(0, 8)}…`);

  // bootstrapTenant emits a "tenant_bootstrap" audit event automatically
  const bootstrapEvt = audit.events.find(e => e.eventKind === 'tenant_bootstrap');
  assert.ok(bootstrapEvt, 'bootstrap audit event should have fired');
  ok(`Audit event: ${bootstrapEvt!.eventKind} for tenant ${bootstrapEvt!.tenantId}`);

  /* ────────────────────────────────────────────────────────────────────────
   * 3. Direct encrypt / decrypt
   *
   * TenantKeyManager.encrypt() returns a sentinel string in the format:
   *   enc:v1:<epoch>:<iv_base64>:<ciphertext_base64>
   *
   * The AAD (Additional Authenticated Data) binds the ciphertext to a
   * specific (tenantId, table, column, rowId) tuple. Attempting to move a
   * ciphertext to a different row or column causes decryption to fail —
   * this prevents ciphertext shuffling attacks.
   *
   * TenantKeyManager.decrypt() uses the field name "value" (not "ciphertext")
   * and automatically passes through plaintext strings that lack the sentinel.
   * ────────────────────────────────────────────────────────────────────────*/
  section('3 — Direct encrypt / decrypt');

  const TABLE   = 'messages';
  const COLUMN  = 'content';
  const ROW_ID  = 'msg-001';
  const plaintext = 'Hello Alice. My SSN is 123-45-6789.';

  // Encrypt: returns a sentinel string stored in place of the plaintext
  const ciphertext = await km.encrypt({
    tenantId: TENANT,
    table: TABLE,
    column: COLUMN,
    rowId: ROW_ID,
    plaintext,
  });

  assert.ok(ciphertext.startsWith('enc:v1:'), 'result should be an enc:v1: sentinel');
  assert.notEqual(ciphertext, plaintext, 'ciphertext must differ from plaintext');
  ok(`Encrypted: ${ciphertext.slice(0, 40)}…`);
  info('Sentinel binds ciphertext to tenant+table+column+rowId via AAD');

  // isEncrypted() detects the enc:v1: prefix — use it before decrypting so
  // plaintext rows (not yet migrated) pass through unchanged.
  assert.ok(isEncrypted(ciphertext), 'isEncrypted should detect the sentinel');
  assert.ok(!isEncrypted(plaintext), 'plain strings should not look encrypted');
  ok('isEncrypted correctly distinguishes sentinel vs plaintext');

  // decrypt uses field name "value" (not "ciphertext") — plaintext values
  // pass through unchanged thanks to the isEncrypted check inside decrypt.
  const recovered = await km.decrypt({
    tenantId: TENANT,
    table: TABLE,
    column: COLUMN,
    rowId: ROW_ID,
    value: ciphertext,   // ← note: "value", not "ciphertext"
  });
  assert.equal(recovered, plaintext, 'decrypted value must match original');
  ok(`Decrypted successfully — plaintext matches original`);

  /* ────────────────────────────────────────────────────────────────────────
   * 4. DEFAULT_FIELD_POLICY and isFieldEncrypted
   *
   * DEFAULT_FIELD_POLICY lists the PII columns shipped with the package:
   *   messages.content, messages.metadata, chats.title, chats.system_prompt,
   *   users.email, users.phone, semantic_memory.content, and more.
   *
   * isFieldEncrypted(policy, table, column) returns true when the (table,
   * column) pair appears in the policy. Your adapter calls this before
   * encrypting to respect which fields the operator has opted into.
   *
   * Operators override the default by setting tenant_encryption_policy.field_policy
   * in the database — mergeFieldPolicy() merges the override on top.
   * ────────────────────────────────────────────────────────────────────────*/
  section('4 — DEFAULT_FIELD_POLICY and isFieldEncrypted');

  assert.ok(isFieldEncrypted(DEFAULT_FIELD_POLICY, 'messages', 'content'),
    'messages.content is PII — in default policy');
  assert.ok(!isFieldEncrypted(DEFAULT_FIELD_POLICY, 'messages', 'id'),
    'messages.id is structural — not in policy');
  assert.ok(isFieldEncrypted(DEFAULT_FIELD_POLICY, 'users', 'email'),
    'users.email is PII — in default policy');
  assert.ok(!isFieldEncrypted(DEFAULT_FIELD_POLICY, 'tool_catalog', 'name'),
    'tool_catalog is structural reference data — never encrypted');

  ok('messages.content     → in policy (PII)');
  ok('messages.id          → NOT in policy (structural)');
  ok('users.email          → in policy (PII)');
  ok('tool_catalog.name    → NOT in policy (structural reference data)');

  /* ────────────────────────────────────────────────────────────────────────
   * 5. Adapter helpers: maybeEncryptField / maybeDecryptField
   *
   * These helpers encode the "skip when…" pass-through rules so your
   * database adapter doesn't need to re-implement them:
   *
   *   maybeEncryptField — skips when:
   *     • manager is null (no master key configured)
   *     • tenant policy is disabled
   *     • (table, column) not in the resolved field policy
   *     • value is null/undefined
   *     • value is already a sentinel (idempotent re-write guard)
   *
   *   maybeDecryptField — skips when:
   *     • manager is null
   *     • value is null/undefined
   *     • value is NOT a sentinel (lazy-upgrade: row not yet encrypted)
   *
   * These are the building blocks used inside createDatabaseProxy() — the
   * transparent wrapper that encrypts/decrypts whole adapters.
   * ────────────────────────────────────────────────────────────────────────*/
  section('5 — Adapter helpers: maybeEncryptField / maybeDecryptField');

  // TenantEncryptionState bundles context needed by maybeEncryptField.
  // Your adapter computes this once per call (or caches per tenant).
  const tenantState: TenantEncryptionState = {
    manager:  km,
    tenantId: TENANT,
    enabled:  policy.enabled,
    policy:   DEFAULT_FIELD_POLICY,
  };

  const userEmail = 'alice@example.com';

  // maybeEncryptField: encrypts only when (table, column) is in the policy
  const encryptedEmail = await maybeEncryptField(
    tenantState,
    { table: 'users', column: 'email', rowId: 'user-001' },
    userEmail,
  );
  assert.ok(isEncrypted(encryptedEmail!), 'users.email should be encrypted');
  ok(`users.email encrypted: ${encryptedEmail!.slice(0, 35)}…`);

  // Structural columns pass through unchanged — no encryption overhead
  const userId = 'user-001';
  const passedThrough = await maybeEncryptField(
    tenantState,
    { table: 'users', column: 'id', rowId: 'user-001' },
    userId,
  );
  assert.equal(passedThrough, userId, 'structural columns pass through unchanged');
  ok(`users.id passed through (not in policy)`);

  // maybeDecryptField: decrypts sentinels, passes plaintext through unchanged
  const decryptedEmail = await maybeDecryptField(
    tenantState,
    { table: 'users', column: 'email', rowId: 'user-001' },
    encryptedEmail!,
  );
  assert.equal(decryptedEmail, userEmail, 'should decrypt back to original email');
  ok(`users.email decrypted: ${decryptedEmail}`);

  // null values pass through — no null checks needed in adapter code
  const nullResult = await maybeEncryptField(
    tenantState,
    { table: 'users', column: 'email', rowId: 'user-001' },
    null,
  );
  assert.equal(nullResult, null, 'null should pass through unchanged');
  ok('null values pass through maybeEncryptField unchanged');

  /* ────────────────────────────────────────────────────────────────────────
   * 6. Blind index — HMAC for exact-match lookups on encrypted fields
   *
   * Encrypted columns can't be searched with SQL LIKE or equality queries.
   * For exact-match lookups (login by email, dedup by phone), the package
   * provides blind indexes: a deterministic HMAC of the plaintext stored in
   * a companion column <column>_bidx.
   *
   * On write: compute bidx = HMAC(bik, plaintext), store both ciphertext AND bidx.
   * On lookup: compute bidx for the search term, run: WHERE email_bidx = bidx.
   *
   * The BIK (Blind Index Key) is created during bootstrapTenant. To activate
   * blind indexing, set blindIndexEnabled=true in the tenant policy.
   *
   * DEFAULT_BLIND_INDEX_SPECS declares which (table, column) pairs are
   * blind-indexed by default (currently: users.email).
   * ────────────────────────────────────────────────────────────────────────*/
  section('6 — Blind index for searchable encrypted fields');

  // Enable blind indexing by flipping blindIndexEnabled in the policy.
  // bootstrapTenant always creates a BIK — this flag just gates writes.
  const policyWithBi: TenantPolicyRecord = { ...policy, blindIndexEnabled: true };
  await store.upsertPolicy(policyWithBi);

  // Compute a blind index directly on the manager
  const searchEmail = 'bob@example.com';
  const bidx = await km.computeBlindIndex({
    tenantId: TENANT,
    table:    'users',
    column:   'email',
    value:    searchEmail,
  });
  assert.ok(typeof bidx === 'string' && bidx.length > 0, 'blind index must be non-empty');
  ok(`Blind index for "bob@example.com": ${bidx}`);

  // The same plaintext always produces the same bidx (deterministic HMAC)
  const bidx2 = await km.computeBlindIndex({
    tenantId: TENANT, table: 'users', column: 'email', value: searchEmail,
  });
  assert.equal(bidx, bidx2, 'same plaintext → same blind index');
  ok('Deterministic: same input → same HMAC output');

  // Different values always produce different bidxs
  const bidxOther = await km.computeBlindIndex({
    tenantId: TENANT, table: 'users', column: 'email', value: 'eve@example.com',
  });
  assert.notEqual(bidx, bidxOther, 'different plaintext → different blind index');
  ok('Different inputs → different blind indexes (no false matches)');

  // maybeBlindIndex is the adapter-layer helper — mirrors maybeEncryptField.
  // BlindIndexState bundles the context for the blind-index decision.
  const biState: BlindIndexState = {
    manager:  km,
    tenantId: TENANT,
    enabled:  true,            // false → skip all blind index writes
    specs:    DEFAULT_BLIND_INDEX_SPECS,  // which (table, column) pairs to index
  };

  const bidxViaHelper = await maybeBlindIndex(biState, 'users', 'email', searchEmail);
  assert.equal(bidxViaHelper, bidx, 'maybeBlindIndex should match direct computeBlindIndex');
  ok('maybeBlindIndex adapter helper produces the same bidx');

  // Returns null for fields not in the specs — no error thrown
  const bidxMissed = await maybeBlindIndex(biState, 'messages', 'content', 'some value');
  assert.equal(bidxMissed, null, 'messages.content not in DEFAULT_BLIND_INDEX_SPECS → null');
  ok('Returns null for columns not in the blind-index specs');

  /* ────────────────────────────────────────────────────────────────────────
   * 7. InMemoryMetricsEmitter
   *
   * InMemoryMetricsEmitter collects counters and histograms emitted by the
   * manager. This gives you visibility into:
   *   • How many encrypt/decrypt operations have occurred
   *   • Cache hit/miss ratios for DEK and KEK caches
   *   • KMS wrap/unwrap latencies
   *   • AEAD errors
   *
   * Wire InMemoryMetricsEmitter to your admin dashboard, or swap it for an
   * OTel or Prometheus adapter in production.
   * ────────────────────────────────────────────────────────────────────────*/
  section('7 — InMemoryMetricsEmitter');

  // snapshot() returns all accumulated metric series since construction.
  // Each series has a name, kind ('histogram' | 'counter'), labels, and stats.
  const snap = metrics.snapshot();

  const encSeries = snap.series.filter(s => s.name === 'encryption.encrypt.duration_ms');
  const decSeries = snap.series.filter(s => s.name === 'encryption.decrypt.duration_ms');
  const hitSeries = snap.series.filter(s => s.name === 'encryption.cache.hit');

  ok(`Encrypt histogram series: ${encSeries.length}`);
  ok(`Decrypt histogram series: ${decSeries.length}`);
  ok(`Cache-hit counter series: ${hitSeries.length}`);

  // Histogram stats include count, p50, p95, p99 in milliseconds
  if (encSeries.length > 0 && encSeries[0]!.kind === 'histogram') {
    const h = encSeries[0]!.histogram!;
    info(`Encrypt ops: count=${h.count} p50=${h.p50.toFixed(2)}ms p99=${h.p99.toFixed(2)}ms`);
  }

  /* ────────────────────────────────────────────────────────────────────────
   * 8. Audit log
   *
   * Every key lifecycle operation (create, rotate, revoke) and every policy
   * change emits an EncryptionAuditEvent. In production persist these to an
   * append-only encryption_audit table for compliance (GDPR, SOC 2, etc.).
   *
   * noopAuditEmitter discards all events — useful in unit tests.
   * CapturingAudit (above) keeps them in an array — useful here.
   * ────────────────────────────────────────────────────────────────────────*/
  section('8 — Audit log');

  const eventKinds = [...new Set(audit.events.map(e => e.eventKind))];
  ok(`Audit event kinds captured: ${eventKinds.join(', ')}`);
  info('In production these go to the encryption_audit table');

  // noopAuditEmitter is the zero-overhead drop-in for tests / CI
  assert.ok(typeof noopAuditEmitter.emit === 'function');
  ok('noopAuditEmitter available — discards all events with zero overhead');

  /* ────────────────────────────────────────────────────────────────────────
   * 9. DEK rotation
   *
   * rotateDek() provisions a new DEK (epoch+1) wrapped under the current KEK
   * and marks the old DEK as 'previous'. The manager automatically uses the
   * new epoch for all future encrypts. Old ciphertext at epoch N remains
   * readable — the manager unwraps old DEKs on demand.
   *
   * After rotation, schedule weaveRewriteScheduler() to gradually re-encrypt
   * old rows under the new epoch so old DEKs can eventually be revoked.
   * ────────────────────────────────────────────────────────────────────────*/
  section('9 — DEK rotation');

  const preDeks  = await store.listDeks();
  const preDekId = preDeks.find(d => d.status === 'active')?.id;

  // rotateDek: creates a new DEK, marks old one as 'previous'
  await km.rotateDek(TENANT);

  const postDeks  = await store.listDeks();
  const activeDek = postDeks.find(d => d.status === 'active');
  const prevDek   = postDeks.find(d => d.status === 'previous');

  assert.ok(activeDek, 'should have one active DEK');
  assert.ok(prevDek,   'old DEK should be marked previous');
  assert.notEqual(activeDek!.id, preDekId, 'active DEK ID should have changed');

  ok(`DEK rotated — new active: ${activeDek!.id.slice(0, 8)}… epoch=${activeDek!.epoch}`);
  ok(`Old DEK status: ${prevDek!.status} (epoch=${prevDek!.epoch})`);

  // New encryptions use epoch 2 automatically
  const newCt = await km.encrypt({
    tenantId: TENANT, table: TABLE, column: COLUMN, rowId: 'msg-002',
    plaintext: 'Post-rotation message',
  });
  const newEpoch = parseInt(newCt.split(':')[2]!, 10);
  assert.equal(newEpoch, 2, 'new ciphertext should carry epoch 2');
  ok(`New ciphertext epoch: ${newEpoch}`);

  // Epoch-1 ciphertext (from section 3) is still decryptable
  const recoveredOld = await km.decrypt({
    tenantId: TENANT, table: TABLE, column: COLUMN, rowId: ROW_ID,
    value: ciphertext,
  });
  assert.equal(recoveredOld, plaintext, 'old ciphertext must still decrypt after rotation');
  ok('Epoch-1 ciphertext still decryptable after rotation');

  /* ────────────────────────────────────────────────────────────────────────
   * 10. InMemoryRewriteJobStore
   *
   * After DEK rotation, existing rows still carry epoch-1 ciphertext. The
   * rewrite scheduler walks those rows and re-encrypts them under the new DEK
   * so the old DEK can eventually be revoked.
   *
   * InMemoryRewriteJobStore (exported by the package) is a usable in-process
   * job store for tests and single-process deployments. In production you
   * persist rewrite jobs to a database so they survive restarts.
   * ────────────────────────────────────────────────────────────────────────*/
  section('10 — InMemoryRewriteJobStore');

  // InMemoryRewriteJobStore IS from @weaveintel/encryption — not a local helper.
  const jobStore = new InMemoryRewriteJobStore();

  const JOB_ID = 'job-001';
  await jobStore.upsert({
    id:            JOB_ID,
    tenantId:      TENANT,
    tableName:     TABLE,
    columnName:    COLUMN,
    fromEpoch:     1,
    toEpoch:       2,
    lastRowId:     null,
    rowsRewritten: 0,
    status:        'pending',
    errorMessage:  null,
    createdAt:     Date.now(),
    updatedAt:     Date.now(),
    completedAt:   null,
  });

  const jobs = await jobStore.list({ tenantId: TENANT });
  assert.equal(jobs.length, 1, 'should have one rewrite job');
  assert.equal(jobs[0]!.status, 'pending');
  ok(`Rewrite job created: ${JOB_ID} — ${TABLE}.${COLUMN} epoch 1→2`);

  // Simulate batch progress (the scheduler calls recordProgress per batch)
  await jobStore.recordProgress(JOB_ID, { lastRowId: 'msg-001', rowsRewritten: 1 }, Date.now());
  const updated = await jobStore.get(JOB_ID);
  assert.equal(updated!.rowsRewritten, 1);
  ok(`Progress: ${updated!.rowsRewritten} rows rewritten, last rowId: ${updated!.lastRowId}`);

  /* ────────────────────────────────────────────────────────────────────────
   * 11. Hard shred (GDPR right-to-be-forgotten)
   *
   * hardShred() deletes all wrapped key material (KEKs, DEKs, BIKs) for a
   * tenant from the EncryptionStore. After this call, all ciphertext for that
   * tenant becomes permanently undecryptable — the cryptographic equivalent
   * of deleting the data without touching the raw rows.
   *
   * This supports GDPR Article 17 "right to erasure" without needing to walk
   * and delete every encrypted field in every table.
   * ────────────────────────────────────────────────────────────────────────*/
  section('11 — Hard shred (GDPR right-to-be-forgotten)');

  const store3 = new InMemoryEncryptionStore();
  const km3    = weaveTenantKeyManager({ store: store3, kms, audit: noopAuditEmitter, metrics });

  const DOOMED = 'doomed-tenant';
  await km3.bootstrapTenant({ tenantId: DOOMED, enable: true });

  const preShrCt = await km3.encrypt({
    tenantId: DOOMED, table: 'messages', column: 'content', rowId: 'r-1',
    plaintext: 'Secret data',
  });
  assert.ok(isEncrypted(preShrCt), 'should be encrypted before shred');
  ok(`Pre-shred ciphertext: ${preShrCt.slice(0, 35)}…`);

  // hardShred: marks policy as shred-requested, then deletes all wrapped material
  await km3.hardShred(DOOMED);

  const remainingKeks = await store3.listKeks();
  const remainingDeks = await store3.listDeks();
  assert.equal(remainingKeks.length, 0, 'all KEKs should be deleted');
  assert.equal(remainingDeks.length, 0, 'all DEKs should be deleted');
  ok('Hard shred complete — all wrapped key material deleted');

  // Decrypting after shred throws — no active DEK to unwrap
  let threwAfterShred = false;
  try {
    await km3.decrypt({
      tenantId: DOOMED, table: 'messages', column: 'content', rowId: 'r-1',
      value: preShrCt,
    });
  } catch {
    threwAfterShred = true;
  }
  assert.ok(threwAfterShred, 'decrypt should throw after hard shred');
  ok('Decrypt throws after shred — ciphertext permanently inaccessible');

  /* ─── Summary ──────────────────────────────────────────────────────────── */
  header('All checks passed');
  console.log(`
  What you just saw:
     1.  LocalKmsProvider     — in-process AES-256-GCM KMS, no cloud dependency
     2.  TenantKeyManager     — bootstraps KEK + DEK + BIK per tenant
     3.  Direct encrypt       — enc:v1: sentinel with AAD binding
     4.  DEFAULT_FIELD_POLICY — which PII columns are encrypted by default
     5.  Adapter helpers      — maybeEncryptField / maybeDecryptField pass-through rules
     6.  Blind index          — deterministic HMAC for searchable encrypted fields
     7.  Metrics              — InMemoryMetricsEmitter counts crypto operations
     8.  Audit log            — CapturingAudit vs noopAuditEmitter
     9.  DEK rotation         — new epoch; old ciphertext still decryptable
    10.  RewriteJobStore      — track background re-encryption progress
    11.  Hard shred           — GDPR erasure via cryptographic key destruction

  Next steps for production:
    • Swap LocalKmsProvider → AwsKmsProvider / GcpKmsProvider / AzureKeyVaultProvider
    • Wire TenantKeyManager into geneweave's SQLite adapter (or your own)
    • Use createDatabaseProxy() for transparent adapter-level encryption
    • Schedule weaveRewriteScheduler() after each DEK rotation
    • Persist audit events to the encryption_audit table
    • Export InMemoryMetricsEmitter.dump() data to your monitoring stack
  `);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
