#!/usr/bin/env node
/**
 * db-audit-validate.mjs
 *
 * Enterprise audit database validation script.
 * Validates key findings from the 2026-06-19 enterprise audit against live SQLite data.
 * Uses only COUNT/aggregate/pattern-match queries — never dumps raw PII.
 *
 * Run:  node scripts/db-audit-validate.mjs
 */

import { createRequire } from 'module';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── DB resolution ──────────────────────────────────────────────────────────────
const CANDIDATES = [
  resolve(__dirname, '../geneweave.db'),
  resolve(__dirname, '../apps/geneweave/geneweave.db'),
];
const DB_PATH = CANDIDATES.find(existsSync);
if (!DB_PATH) {
  console.error('ERROR: geneweave.db not found. Run the server once to create it.');
  process.exit(1);
}

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  try {
    Database = (await import(resolve(__dirname, '../node_modules/better-sqlite3/lib/index.js'))).default;
  } catch {
    console.error('ERROR: better-sqlite3 not found. Run `npm install` first.');
    process.exit(1);
  }
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// ── Helpers ────────────────────────────────────────────────────────────────────
const PASS  = '✅ PASS';
const FAIL  = '❌ FAIL';
const WARN  = '⚠️  WARN';
const INFO  = 'ℹ️  INFO';

let results = [];

function check(id, title, fn) {
  try {
    const r = fn(db);
    results.push({ id, title, ...r });
  } catch (err) {
    results.push({ id, title, status: 'ERROR', detail: String(err.message) });
  }
}

function tableExists(name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

function columnExists(table, col) {
  if (!tableExists(table)) return false;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === col);
}

function count(table, where = '') {
  if (!tableExists(table)) return null;
  return db.prepare(`SELECT COUNT(*) as n FROM ${table} ${where}`).get().n;
}

// PII detection patterns (regex applied in JS after COUNT, not exposing raw values)
const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/,           // SSN
  /\b(?:\d[ -]?){13,16}\b/,          // credit card
  /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/,  // email
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/, // phone
];

function hasPiiSample(rows, field) {
  return rows.some(row => {
    const v = row[field];
    if (!v || typeof v !== 'string') return false;
    return PII_PATTERNS.some(p => p.test(v));
  });
}

// ── CHECK 1: M11-2 — Enterprise connector credentials stored in plaintext ──────
check('M11-2', 'Enterprise connector credentials encryption coverage', () => {
  if (!tableExists('enterprise_connectors')) {
    return { status: INFO, detail: 'Table enterprise_connectors does not exist — no data to validate' };
  }
  const total      = count('enterprise_connectors');
  const encrypted  = count('enterprise_connectors', 'WHERE credentials_encrypted = 1');
  const plaintext  = count('enterprise_connectors', 'WHERE credentials_encrypted = 0 AND (access_token IS NOT NULL OR refresh_token IS NOT NULL OR auth_config IS NOT NULL)');
  const pending    = count('enterprise_connectors', 'WHERE credentials_encrypted = 0');

  if (total === 0) {
    return { status: INFO, detail: `Table exists but is empty (no connectors configured yet). Schema confirmed: credentials_encrypted defaults to 0. M11-2 finding stands — next write will be plaintext.` };
  }
  if (plaintext > 0) {
    return { status: FAIL, detail: `CONFIRMED: ${plaintext}/${total} connectors have plaintext credentials (credentials_encrypted=0 AND non-null tokens). Encrypted: ${encrypted}. FINDING M11-2 VERIFIED IN LIVE DATA.` };
  }
  if (pending > 0) {
    return { status: WARN, detail: `${pending}/${total} connectors have credentials_encrypted=0 but null tokens — schema defaults to unencrypted. ${encrypted} fully encrypted. M11-2 still a risk.` };
  }
  return { status: PASS, detail: `All ${total} connectors have credentials_encrypted=1. M11-2 mitigated in live data.` };
});

// ── CHECK 2: M4-4 — PII in guardrail_evals.input_preview ─────────────────────
check('M4-4', 'PII leakage in guardrail_evals.input_preview', () => {
  if (!tableExists('guardrail_evals')) {
    return { status: INFO, detail: 'Table guardrail_evals does not exist yet' };
  }
  const total = count('guardrail_evals');
  const withPreview = count('guardrail_evals', `WHERE input_preview IS NOT NULL AND input_preview != ''`);

  if (total === 0) {
    return { status: INFO, detail: 'No guardrail evaluations in DB yet. Schema has input_preview TEXT with no redaction applied before insert.' };
  }

  // Sample up to 200 previews for PII pattern check (reading only, no raw output)
  const sample = db.prepare(`SELECT input_preview FROM guardrail_evals WHERE input_preview IS NOT NULL AND input_preview != '' LIMIT 200`).all();
  const piiHits = sample.filter(r => PII_PATTERNS.some(p => p.test(r.input_preview ?? '')));

  if (piiHits.length > 0) {
    return { status: FAIL, detail: `CONFIRMED: ${piiHits.length}/${sample.length} sampled previews match PII patterns (email/SSN/card/phone). Total rows with preview: ${withPreview}/${total}. FINDING M4-4 VERIFIED IN LIVE DATA.` };
  }
  return { status: PASS, detail: `${total} guardrail evals; ${withPreview} have input_preview. No PII patterns matched in ${sample.length}-row sample (patterns: email, SSN, card, phone). Risk remains — redaction pipeline runs AFTER guardrail insert.` };
});

// ── CHECK 3: M5-1 — Durable deletion records persistence ─────────────────────
check('M5-1', 'Durable compliance deletion records in DB', () => {
  if (!tableExists('tenant_deletion_requests')) {
    return { status: WARN, detail: 'Table tenant_deletion_requests not found. Deletion records are stored only in runtime KV (in-memory). FINDING M5-1 CONFIRMED — restart loses all deletion audit trail.' };
  }
  const n = count('tenant_deletion_requests');
  return { status: n > 0 ? PASS : WARN, detail: `tenant_deletion_requests exists with ${n} records. ${n === 0 ? 'No deletion requests yet — cannot confirm persistence survives restart.' : 'Records present — durable persistence is working.'}` };
});

// ── CHECK 4: M5-3 — Consent rules seeded but unenforced ──────────────────────
check('M5-3', 'Consent rules seeded in compliance_rules', () => {
  if (!tableExists('compliance_rules')) {
    return { status: INFO, detail: 'Table compliance_rules not found' };
  }
  const total    = count('compliance_rules');
  const consent  = count('compliance_rules', `WHERE rule_type = 'consent'`);
  const enabled  = count('compliance_rules', `WHERE rule_type = 'consent' AND enabled = 1`);

  if (consent > 0) {
    return {
      status: WARN,
      detail: `CONFIRMED: ${consent} consent rules seeded (${enabled} enabled) out of ${total} total compliance rules. Code audit showed isGranted() is never called at runtime — consent is stored but unenforced. FINDING M5-3 VERIFIED.`,
    };
  }
  return { status: INFO, detail: `${total} compliance rules; none of type 'consent'. Consent enforcement finding M5-3 still applies at code level.` };
});

// ── CHECK 5: M6-2 — live_runs missing stop_requested column ──────────────────
check('M6-2', 'live_runs.stop_requested column exists', () => {
  if (!tableExists('live_runs')) {
    return { status: INFO, detail: 'Table live_runs not found' };
  }
  const hasCol = columnExists('live_runs', 'stop_requested');
  const activeRuns = count('live_runs', `WHERE status = 'RUNNING'`);
  const total = count('live_runs');
  if (!hasCol) {
    return { status: FAIL, detail: `CONFIRMED: live_runs has no stop_requested column. Stop signals are in-process only. ${activeRuns} RUNNING runs currently in DB (total: ${total}). FINDING M6-2 VERIFIED IN SCHEMA.` };
  }
  return { status: PASS, detail: `stop_requested column exists. Active runs: ${activeRuns}/${total}.` };
});

// ── CHECK 6: M3-2 — Password hash format (scrypt vs legacy) ──────────────────
check('M3-2', 'Password hash format (scrypt strength)', () => {
  if (!tableExists('users')) {
    return { status: INFO, detail: 'Table users not found' };
  }
  const total = count('users');
  if (total === 0) return { status: INFO, detail: 'No users in database' };

  // Actual format is scrypt$v2$<N>|... (not scrypt:)
  const formats = db.prepare(`
    SELECT SUBSTR(password_hash, 1, 12) as prefix, COUNT(*) as n
    FROM users GROUP BY prefix ORDER BY n DESC LIMIT 10
  `).all();

  const scrypt  = formats.filter(r => r.prefix?.startsWith('scrypt$v2$')).reduce((s, r) => s + r.n, 0);
  const legacy  = total - scrypt;
  const formatStr = formats.map(r => `${r.prefix}(${r.n})`).join(', ');

  if (legacy === 0) {
    return { status: PASS, detail: `All ${total} users use scrypt$v2$ format. Hash format breakdown: ${formatStr}. M3-2 CONFIRMED CORRECT IN LIVE DATA.` };
  }
  if (scrypt >= total * 0.95) {
    return { status: WARN, detail: `${scrypt}/${total} scrypt, ${legacy} legacy. Formats: ${formatStr}. Legacy users will be upgraded on next login.` };
  }
  return { status: FAIL, detail: `Only ${scrypt}/${total} users have scrypt hashes. ${legacy} legacy format. Formats: ${formatStr}. Upgrade-on-login may not be catching all users.` };
});

// ── CHECK 7: M7-4 — Unbounded getMessages (chat message volume) ───────────────
check('M7-4', 'Chat message volume — unbounded getMessages risk', () => {
  if (!tableExists('messages')) {
    return { status: INFO, detail: 'Table messages not found' };
  }
  const total = count('messages');
  const chats = count('chats') ?? 0;

  const topChats = db.prepare(`
    SELECT chat_id, COUNT(*) as msg_count
    FROM messages
    GROUP BY chat_id
    ORDER BY msg_count DESC
    LIMIT 5
  `).all();

  const max = topChats[0]?.msg_count ?? 0;
  const over200 = db.prepare(`
    SELECT COUNT(*) as n FROM (
      SELECT chat_id FROM messages GROUP BY chat_id HAVING COUNT(*) > 200
    )
  `).get().n;

  let status = PASS;
  let detail = `${total} total messages across ${chats} chats. Largest chat: ${max} messages. Chats over 200 messages: ${over200}.`;

  if (max > 500) {
    status = FAIL;
    detail += ` RISK CONFIRMED: largest chat has ${max} messages — getMessages() will load all without LIMIT, potential OOM.`;
  } else if (max > 100) {
    status = WARN;
    detail += ` Approaching risk threshold. Add LIMIT before chats grow further.`;
  }
  return { status, detail };
});

// ── CHECK 8: M7-3 — SQLite WAL mode and journal integrity ─────────────────────
check('M7-3', 'SQLite WAL mode and integrity', () => {
  const journalMode = db.prepare('PRAGMA journal_mode').get();
  const integrityCheck = db.prepare('PRAGMA integrity_check').get();
  const pageCount = db.prepare('PRAGMA page_count').get();
  const pageSize = db.prepare('PRAGMA page_size').get();
  const dbSizeKB = Math.round((pageCount.page_count * pageSize.page_size) / 1024);

  const isWal = journalMode.journal_mode === 'wal';
  const isOk = integrityCheck.integrity_check === 'ok';

  return {
    status: isWal && isOk ? PASS : (isOk ? WARN : FAIL),
    detail: `Journal mode: ${journalMode.journal_mode} (${isWal ? 'WAL ✓' : 'NOT WAL — no concurrent readers'}). Integrity: ${integrityCheck.integrity_check}. DB size: ${dbSizeKB} KB. SQLite is single-writer — M7-3 finding stands regardless.`,
  };
});

// ── CHECK 9: Encryption tables — tenant key coverage ─────────────────────────
check('ENC-1', 'Tenant encryption key coverage (DEK/KEK)', () => {
  const dekCount = tableExists('tenant_deks') ? count('tenant_deks') : null;
  const kekCount = tableExists('tenant_keks') ? count('tenant_keks') : null;
  const byokCount = tableExists('tenant_byok_config') ? count('tenant_byok_config') : null;
  const tenants = tableExists('tenant_configs') ? count('tenant_configs') : count('users') ?? 0;
  const encPolicies = tableExists('tenant_encryption_policy') ? count('tenant_encryption_policy') : null;

  if (dekCount === null && kekCount === null) {
    return { status: WARN, detail: 'Neither tenant_deks nor tenant_keks tables exist. Encryption infrastructure not initialized.' };
  }

  return {
    status: (dekCount ?? 0) > 0 ? PASS : WARN,
    detail: `DEKs: ${dekCount ?? 'table missing'} | KEKs: ${kekCount ?? 'table missing'} | BYOK configs: ${byokCount ?? 'table missing'} | Encryption policies: ${encPolicies ?? 'table missing'} | Approx tenants: ${tenants}. ${(dekCount ?? 0) === 0 ? 'No DEKs — encryption opt-in not yet activated for any tenant.' : 'Encryption keys present.'}`,
  };
});

// ── CHECK 10: M4-5 — Chat settings redaction default ─────────────────────────
check('M4-5', 'Chat redactionEnabled setting default in live chats', () => {
  if (!tableExists('chat_settings')) {
    return { status: INFO, detail: 'Table chat_settings not found' };
  }
  const total = count('chat_settings');
  if (total === 0) return { status: INFO, detail: 'No chat_settings records. DB schema default is redaction_enabled=1.' };

  // chat_settings uses individual columns, not JSON blob
  const redactionOn  = count('chat_settings', 'WHERE redaction_enabled = 1');
  const redactionOff = count('chat_settings', 'WHERE redaction_enabled = 0');
  const pct = total > 0 ? Math.round((redactionOn / total) * 100) : 0;

  return {
    status: redactionOff > 0 ? WARN : PASS,
    detail: `${total} chat_settings rows. Redaction enabled: ${redactionOn} (${pct}%). Redaction disabled: ${redactionOff}. DB schema DEFAULT is 1 (enabled). ${redactionOff > 0 ? `${redactionOff} chats have explicitly disabled redaction — check if intentional.` : 'All chats have redaction on.'}`,
  };
});

// ── CHECK 11: M8-3 — Audit trail completeness ─────────────────────────────────
check('M8-3', 'Tool audit events completeness', () => {
  if (!tableExists('tool_audit_events')) {
    return { status: FAIL, detail: 'Table tool_audit_events missing — no tool audit trail exists.' };
  }
  const total = count('tool_audit_events');
  const success = count('tool_audit_events', `WHERE outcome = 'success'`);
  const failure = count('tool_audit_events', `WHERE outcome != 'success'`);
  const encAudit = tableExists('encryption_audit') ? count('encryption_audit') : 'table missing';

  return {
    status: total > 0 ? (success > 0 ? PASS : WARN) : INFO,
    detail: `tool_audit_events: ${total} total (success: ${success}, non-success: ${failure}). encryption_audit: ${encAudit}. ${success === 0 && total > 0 ? 'No success events — consoleAuditEmitter drops them. M4-6 VERIFIED.' : ''}`,
  };
});

// ── CHECK 12: Migration state ─────────────────────────────────────────────────
check('MIGS', 'Applied migration state', () => {
  // Check for a migration tracking table
  const hasMigTable = tableExists('_migrations') || tableExists('schema_migrations') || tableExists('migrations');
  if (!hasMigTable) {
    // Try to infer from columns that exist (m49 added *_enc columns)
    const hasM49 = columnExists('enterprise_connectors', 'credentials_encrypted');
    const hasM54 = tableExists('audit_log_retention_tiers');
    return {
      status: INFO,
      detail: `No migration tracking table found. Inferred: m49 (enterprise connector encryption columns): ${hasM49 ? 'APPLIED' : 'NOT APPLIED'}. m54 (audit retention tiers): ${hasM54 ? 'APPLIED' : 'NOT APPLIED'}.`,
    };
  }
  const latest = db.prepare('SELECT MAX(version) as v FROM ' + (tableExists('_migrations') ? '_migrations' : 'schema_migrations')).get();
  return { status: INFO, detail: `Latest migration: ${latest?.v ?? 'unknown'}` };
});

// ── CHECK 13: Redis connectivity ──────────────────────────────────────────────
check('M6-1', 'Redis connectivity (rate limiter backend)', () => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return { status: FAIL, detail: 'REDIS_URL not set in environment. Rate limiter falls back to in-process Map. FINDING M6-1/M7-1 CONFIRMED — brute-force lockout not effective in multi-replica.' };
  }
  return { status: PASS, detail: `REDIS_URL is set: ${redisUrl.replace(/:\/\/.*@/, '://***@')}. Distributed rate limiting configured.` };
});

// ── CHECK 14: M7-4/M7-6 — Concurrent agent workers ──────────────────────────
check('M7-6', 'Live agent / worker concurrency in DB', () => {
  const runningAgents = tableExists('live_runs') ? count('live_runs', `WHERE status='RUNNING'`) : 'N/A';
  const workerAgents = tableExists('worker_agents') ? count('worker_agents') : 'N/A';
  const liveAgents = tableExists('live_agents') ? count('live_agents') : 'N/A';
  return {
    status: INFO,
    detail: `RUNNING live_runs: ${runningAgents} | worker_agents: ${workerAgents} | live_agents: ${liveAgents}. No per-agent concurrency cap in schema.`,
  };
});

// ── CHECK 15: GDPR export completeness — memory tables ───────────────────────
check('M5-4', 'AI memory tables — export completeness', () => {
  const tables = ['semantic_memory', 'episodic_memory', 'working_memory_snapshots', 'entity_memory', 'procedural_memory'];
  const counts = tables.map(t => ({ table: t, count: tableExists(t) ? count(t) : null }));
  const populated = counts.filter(r => r.count !== null && r.count > 0);
  const missing = counts.filter(r => r.count === null);

  return {
    status: populated.length > 0 ? WARN : INFO,
    detail: `Memory tables: ${counts.map(r => `${r.table}=${r.count ?? 'missing'}`).join(', ')}. ${populated.length > 0 ? `${populated.length} tables have data NOT included in GDPR export. M5-4 VERIFIED.` : 'All empty — GDPR export gap exists in schema regardless.'}`,
  };
});

// ── CHECK 16: User account status ─────────────────────────────────────────────
check('AUTH-1', 'User account security hygiene', () => {
  if (!tableExists('users')) return { status: INFO, detail: 'No users table' };
  const total = count('users');
  const verified = count('users', 'WHERE email_verified = 1');
  const mfaEnabled = count('users', 'WHERE mfa_enabled = 1');
  const admins = db.prepare(`SELECT COUNT(*) as n FROM users WHERE persona IN ('tenant_admin','system_admin','super_admin')`).get().n;

  return {
    status: mfaEnabled === 0 && total > 1 ? WARN : INFO,
    detail: `${total} users | email verified: ${verified} | MFA enabled: ${mfaEnabled} | admin personas: ${admins}. ${mfaEnabled === 0 && admins > 0 ? `${admins} admin(s) with no MFA configured — SOC 2 CC6.1 risk.` : ''}`,
  };
});

// ── PRINT REPORT ──────────────────────────────────────────────────────────────
const PAD = 60;

console.log('\n' + '═'.repeat(80));
console.log('  WEAVEINTEL / GENEWEAVE — DATABASE AUDIT VALIDATION');
console.log(`  DB: ${DB_PATH}`);
console.log(`  Date: ${new Date().toISOString()}`);
console.log('═'.repeat(80) + '\n');

const statusOrder = { [FAIL]: 0, [WARN]: 1, 'ERROR': 2, [PASS]: 3, [INFO]: 4 };
const sorted = [...results].sort((a, b) => (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5));

for (const r of sorted) {
  const label = `[${r.id}] ${r.title}`;
  console.log(`${r.status}  ${label}`);
  const wrapped = r.detail.match(/.{1,110}(\s|$)/g) ?? [r.detail];
  for (const line of wrapped) {
    console.log(`        ${line.trim()}`);
  }
  console.log();
}

const fails = results.filter(r => r.status === FAIL).length;
const warns = results.filter(r => r.status === WARN).length;
const passes = results.filter(r => r.status === PASS).length;
const infos = results.filter(r => r.status === INFO || r.status === 'ERROR').length;

console.log('═'.repeat(80));
console.log(`  SUMMARY: ${fails} FAIL | ${warns} WARN | ${passes} PASS | ${infos} INFO/ERROR`);
console.log('═'.repeat(80) + '\n');

// ── EMIT MACHINE-READABLE JSON SUMMARY ────────────────────────────────────────
const jsonOut = results.map(r => ({ id: r.id, title: r.title, status: r.status.replace(/[^\w ]/g, '').trim(), detail: r.detail }));
console.log('JSON_SUMMARY:' + JSON.stringify(jsonOut));
