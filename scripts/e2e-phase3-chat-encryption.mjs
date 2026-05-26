#!/usr/bin/env node
// scripts/e2e-phase3-chat-encryption.mjs
//
// E2E for Tenant Encryption Phase 3 — chat-message encryption at rest.
//
// Validates the Proxy-wrapped DatabaseAdapter (`withTenantEncryptedMessages`)
// end-to-end against a live server:
//
//   1. register + promote + login
//   2. enable encryption for the user's tenant (auto-bootstrap KEK+DEK)
//   3. create chat
//   4. send a chat message via API → assistant reply persisted under wrapper
//   5. inspect raw SQLite: messages.content + messages.metadata MUST start
//      with `enc:v1:` (sentinel) for both user + assistant rows
//   6. GET /api/chats/:chatId/messages → bodies decrypted to plaintext
//   7. simulate legacy plaintext (raw INSERT bypassing wrapper) →
//      GET still returns it transparently (lazy-upgrade tolerance)
//   8. rotate-dek → send another message → new sentinel epoch >= prev
//   9. cleanup
//
// REQUIRES:
//   - server running on $BASE_URL (default http://localhost:3500) with
//     WEAVE_ENCRYPTION_MASTER_KEY exported (boot via `bash /tmp/start-gw.sh`)
//   - sqlite3 CLI on PATH
//   - an LLM provider key in .env (OPENAI_API_KEY or ANTHROPIC_API_KEY) so
//     /api/chats/:chatId/messages succeeds
//
// Usage: zsh> set +H && node scripts/e2e-phase3-chat-encryption.mjs

import { execSync } from 'node:child_process';
import { BASE, DB_PATH, makeOk, jfetch } from './e2e-helpers.mjs';

const ok = makeOk();
const ts = Date.now();
const email = `e2e_phase3_enc_${ts}@example.com`;
const password = 'P@ssw0rd123';

function sql(query) {
  // Returns rows as pipe-separated lines. Use -separator '|' (default) and -noheader.
  return execSync(`sqlite3 "${DB_PATH}" "${query.replace(/"/g, '\\"')}"`).toString('utf8').trim();
}

console.log(`\n=== Phase 3 E2E (chat message encryption at rest) — ${BASE} ===\n`);

// 1. Register + promote
console.log('1. Register + promote to tenant_admin');
const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'enc-phase3' } });
ok(reg.status === 201 || reg.status === 200, `register status=${reg.status}`);
execSync(`sqlite3 ${DB_PATH} "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
ok(true, 'promoted to tenant_admin');

// 2. Login + capture csrf + cookie
console.log('2. Login');
const login = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(login.status === 200, `login status=${login.status}`);
const setCookie = login.headers.get('set-cookie') ?? '';
const cookie = setCookie.split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf = login.body?.csrfToken;
ok(typeof csrf === 'string' && csrf.length > 0, 'csrf token present');

// 3. Assign a tenant_id to the user (registration leaves it NULL).
//    Phase 3 needs chat→user→tenant resolution, so the user MUST have a tenant.
const tenantId = `e2e_p3_tenant_${ts}`;
execSync(`sqlite3 ${DB_PATH} "UPDATE users SET tenant_id='${tenantId}' WHERE email='${email}';"`);
const verifyTenant = sql(`SELECT tenant_id FROM users WHERE email='${email}';`);
ok(verifyTenant === tenantId, `tenant_id assigned: ${verifyTenant}`);

// 4. Confirm encryption manager is bootstrapped
console.log('3. Verify encryption manager available');
const policiesList = await jfetch('GET', '/api/admin/tenant-encryption-policies', { cookie });
ok(policiesList.status === 200, `list status=${policiesList.status}`);
if (policiesList.body?.manager_available !== true) {
  console.log('\n⚠️  Encryption manager not bootstrapped. Set WEAVE_ENCRYPTION_MASTER_KEY and restart server.');
  process.exit(2);
}
ok(true, 'manager_available=true');

// 5. Enable encryption for the user's tenant — auto-bootstraps KEK+DEK
console.log('4. POST tenant policy enabled=1 — expect auto-bootstrap');
const created = await jfetch('POST', '/api/admin/tenant-encryption-policies', {
  cookie, csrf,
  body: {
    tenant_id: tenantId,
    enabled: true,
    kms_provider_id: 'local',
    kms_config: { provider: 'local' },
    rotation_schedule: 'manual',
    blind_index_enabled: false,
    field_policy: { messages: { columns: ['content', 'metadata'] } },
  },
});
ok(created.status === 201, `create status=${created.status}`);
ok(created.body?.bootstrapped === true, 'bootstrapped=true');
ok(typeof created.body?.policy?.active_dek_id === 'string', 'active_dek_id assigned');

// 6. Create a chat
console.log('5. Create chat');
const chatRes = await jfetch('POST', '/api/chats', {
  cookie, csrf, body: { title: 'phase3 enc smoke' },
});
ok(chatRes.status === 201, `create-chat status=${chatRes.status}`);
const chatId = chatRes.body?.chat?.id;
ok(typeof chatId === 'string' && chatId.length > 0, `chatId=${chatId}`);

// 7. Send a chat message — wrapper encrypts user + assistant message rows
console.log('6. Send chat message (LLM call — small prompt)');
const sendRes = await jfetch('POST', `/api/chats/${chatId}/messages`, {
  cookie, csrf, body: { content: 'reply with the single word: ok', maxTokens: 5 },
});
if (sendRes.status !== 200) {
  console.log('   send status=', sendRes.status, 'body=', JSON.stringify(sendRes.body).slice(0, 200));
}
ok(sendRes.status === 200, `send-message status=${sendRes.status}`);

// 8. Inspect raw SQLite — content + metadata must be encrypted sentinels for ALL rows
console.log('7. Verify raw SQLite messages are encrypted');
const rawRows = sql(
  `SELECT role || '|' || substr(coalesce(content,''),1,16) || '|' || substr(coalesce(metadata,''),1,16) FROM messages WHERE chat_id='${chatId}' ORDER BY created_at ASC;`
);
const lines = rawRows.split('\n').filter(Boolean);
ok(lines.length >= 1, `at least 1 raw message row (got ${lines.length})`);
for (const line of lines) {
  const [role, contentPrefix, metaPrefix] = line.split('|');
  ok(contentPrefix.startsWith('enc:v1:'), `${role}.content is sentinel (prefix=${contentPrefix})`);
  // metadata may legitimately be NULL for some rows — only check non-null
  if (metaPrefix && metaPrefix !== '') {
    ok(metaPrefix.startsWith('enc:v1:'), `${role}.metadata is sentinel (prefix=${metaPrefix})`);
  }
}

// 9. GET /api/chats/:chatId/messages → bodies decrypted to plaintext
console.log('8. GET messages via API — verify plaintext decryption');
const getMsgs = await jfetch('GET', `/api/chats/${chatId}/messages`, { cookie });
ok(getMsgs.status === 200, `get-messages status=${getMsgs.status}`);
const messages = getMsgs.body?.messages ?? [];
ok(messages.length >= 1, `messages length >= 1 (got ${messages.length})`);
for (const m of messages) {
  ok(typeof m.content === 'string' && !m.content.startsWith('enc:v1:'), `${m.role}.content is plaintext via API`);
}

// 10. Lazy-upgrade: insert a legacy plaintext row directly via sqlite3 → GET still returns it
console.log('9. Simulate legacy plaintext row (raw SQL INSERT, bypasses wrapper)');
const legacyId = `legacy-${ts}`;
const legacyContent = 'legacy plaintext message';
sql(
  `INSERT INTO messages (id, chat_id, role, content, metadata, tokens_used, cost, latency_ms) VALUES ('${legacyId}', '${chatId}', 'user', '${legacyContent}', NULL, 0, 0, 0);`
);
const getMsgs2 = await jfetch('GET', `/api/chats/${chatId}/messages`, { cookie });
ok(getMsgs2.status === 200, `get-messages-2 status=${getMsgs2.status}`);
const legacy = (getMsgs2.body?.messages ?? []).find((m) => m.id === legacyId);
ok(legacy !== undefined, 'legacy row returned');
ok(legacy?.content === legacyContent, 'legacy plaintext returned transparently (lazy-upgrade tolerance)');

// 11. rotate-dek → send another message → new sentinel epoch must increment
console.log('10. Rotate DEK + send new message → epoch must advance');
const epochBefore = sql(
  `SELECT epoch FROM tenant_deks WHERE tenant_id='${tenantId}' AND status='active' ORDER BY epoch DESC LIMIT 1;`
);
const rot = await jfetch('POST', `/api/admin/tenant-encryption-policies/${tenantId}/rotate-dek`, { cookie, csrf });
ok(rot.status === 200, `rotate-dek status=${rot.status}`);
const epochAfter = sql(
  `SELECT epoch FROM tenant_deks WHERE tenant_id='${tenantId}' AND status='active' ORDER BY epoch DESC LIMIT 1;`
);
ok(Number(epochAfter) > Number(epochBefore), `DEK epoch advanced: ${epochBefore} → ${epochAfter}`);

const sendRes2 = await jfetch('POST', `/api/chats/${chatId}/messages`, {
  cookie, csrf, body: { content: 'say: ok', maxTokens: 5 },
});
ok(sendRes2.status === 200, `send-message-2 status=${sendRes2.status}`);

// Pull most recent user message — its sentinel epoch should match epochAfter
const newestUserSentinel = sql(
  `SELECT content FROM messages WHERE chat_id='${chatId}' AND role='user' ORDER BY created_at DESC LIMIT 1;`
);
const newestEpoch = newestUserSentinel.split(':')[2];
ok(
  newestEpoch === String(epochAfter),
  `newest user message sentinel epoch matches active DEK epoch (${newestEpoch} === ${epochAfter})`
);

// 12. GET messages still works after rotation — old + new epochs both readable
console.log('11. Post-rotation: GET still returns plaintext for ALL messages (old + new epochs)');
const getMsgs3 = await jfetch('GET', `/api/chats/${chatId}/messages`, { cookie });
ok(getMsgs3.status === 200, `get-messages-3 status=${getMsgs3.status}`);
const allPlain = (getMsgs3.body?.messages ?? []).every(
  (m) => typeof m.content === 'string' && !m.content.startsWith('enc:v1:')
);
ok(allPlain, 'all messages decrypted to plaintext post-rotation');

// 13. Cleanup
console.log('12. Cleanup');
const delChat = await jfetch('DELETE', `/api/chats/${chatId}`, { cookie, csrf });
ok(delChat.status === 200 || delChat.status === 204, `delete-chat status=${delChat.status}`);

// 12a. DELETE without shred MUST be refused (409) while keys are live.
const delGuard = await jfetch('DELETE', `/api/admin/tenant-encryption-policies/${tenantId}`, { cookie, csrf });
ok(delGuard.status === 409, `delete-policy-before-shred refused status=${delGuard.status}`);

// 12b. Shred (revokes all keys), then DELETE succeeds.
const shred = await jfetch('POST', `/api/admin/tenant-encryption-policies/${tenantId}/shred`, {
  cookie, csrf, body: { confirm: tenantId },
});
ok(shred.status === 200, `shred status=${shred.status}`);
const delPolicy = await jfetch('DELETE', `/api/admin/tenant-encryption-policies/${tenantId}`, { cookie, csrf });
ok(delPolicy.status === 200 || delPolicy.status === 204, `delete-policy status=${delPolicy.status}`);

console.log(`\n✅ All ${ok.count()} assertions passed.\n`);
