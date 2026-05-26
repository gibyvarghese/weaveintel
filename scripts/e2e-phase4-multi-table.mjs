#!/usr/bin/env node
// scripts/e2e-phase4-multi-table.mjs
//
// E2E for Tenant Encryption Phase 4 — multi-table generalized adapter.
//
// Validates `weaveTenantEncryptedProxy<DB>` end-to-end against a live server
// with two encrypted tables in the same tenant: `chats.title` AND
// `messages.content/metadata`. Phase 3 already covers messages-only; this
// script focuses on the multi-table generalization, kill-switch behaviour,
// cross-epoch rotation across BOTH tables, and the shred→delete cleanup
// ordering invariant.
//
//   1. register + promote + login + assign tenant_id
//   2. enable encryption with field_policy spanning chats + messages
//   3. create chat with title "phase4 multi-table" → chats.title MUST
//      persist as `enc:v1:` sentinel; API GET MUST round-trip plaintext
//   4. send chat message → messages.content + messages.metadata MUST
//      persist as `enc:v1:` sentinels; API GET MUST round-trip plaintext
//   5. PUT /api/chats/:id title="renamed via PUT" → exercises the outer
//      Proxy escape hatch for positional-arg `updateChatTitle`. Raw SQL
//      MUST show updated title is also a sentinel.
//   6. KILL-SWITCH: PUT enabled=0 → create a new chat → its title
//      persists plaintext. Old chat's title still decrypts on GET.
//   7. ROTATION: re-enable encryption, rotate-dek → epoch advances. Send
//      a new message; raw sentinel epoch must equal new epoch. Old
//      messages + old chat title still decrypt across epochs.
//   8. CLEANUP: DELETE without shred MUST return 409. Shred → DELETE
//      succeeds.
//
// REQUIRES:
//   - server running on $BASE_URL (default http://localhost:3500) with
//     WEAVE_ENCRYPTION_MASTER_KEY exported (boot via `bash /tmp/start-gw.sh`)
//   - sqlite3 CLI on PATH
//   - an LLM provider key in .env so /api/chats/:id/messages succeeds
//
// Usage: zsh> set +H && node scripts/e2e-phase4-multi-table.mjs

import { execSync } from 'node:child_process';
import { BASE, DB_PATH, makeOk, jfetch } from './e2e-helpers.mjs';

const ok = makeOk();
const ts = Date.now();
const email = `e2e_phase4_enc_${ts}@example.com`;
const password = 'P@ssw0rd123';
const tenantId = `e2e_p4_tenant_${ts}`;

function sql(query) {
  return execSync(`sqlite3 "${DB_PATH}" "${query.replace(/"/g, '\\"')}"`).toString('utf8').trim();
}

console.log(`\n=== Phase 4 E2E (multi-table encryption: chats + messages) — ${BASE} ===\n`);

// 1. Register + promote + assign tenant
console.log('1. Register + promote to tenant_admin + assign tenant_id');
const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'enc-phase4' } });
ok(reg.status === 201 || reg.status === 200, `register status=${reg.status}`);
execSync(`sqlite3 ${DB_PATH} "UPDATE users SET persona='tenant_admin', tenant_id='${tenantId}' WHERE email='${email}';"`);
const verifyTenant = sql(`SELECT tenant_id FROM users WHERE email='${email}';`);
ok(verifyTenant === tenantId, `tenant_id assigned: ${verifyTenant}`);

// 2. Login
console.log('2. Login');
const login = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(login.status === 200, `login status=${login.status}`);
const setCookie = login.headers.get('set-cookie') ?? '';
const cookie = setCookie.split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf = login.body?.csrfToken;
ok(typeof csrf === 'string' && csrf.length > 0, 'csrf token present');

// 3. Confirm encryption manager + enable multi-table policy (auto-bootstrap)
console.log('3. POST tenant policy with field_policy={chats,messages} (auto-bootstrap)');
const policiesList = await jfetch('GET', '/api/admin/tenant-encryption-policies', { cookie });
ok(policiesList.status === 200, `list status=${policiesList.status}`);
if (policiesList.body?.manager_available !== true) {
  console.log('\n⚠️  Encryption manager not bootstrapped. Set WEAVE_ENCRYPTION_MASTER_KEY and restart server.');
  process.exit(2);
}
ok(true, 'manager_available=true');

const created = await jfetch('POST', '/api/admin/tenant-encryption-policies', {
  cookie, csrf,
  body: {
    tenant_id: tenantId,
    enabled: true,
    kms_provider_id: 'local',
    kms_config: { provider: 'local' },
    rotation_schedule: 'manual',
    blind_index_enabled: false,
    field_policy: {
      chats: { columns: ['title'] },
      messages: { columns: ['content', 'metadata'] },
    },
  },
});
ok(created.status === 201, `create-policy status=${created.status}`);
ok(created.body?.bootstrapped === true, 'bootstrapped=true');
ok(typeof created.body?.policy?.active_dek_id === 'string', 'active_dek_id assigned');

// 4. Create a chat with a meaningful title — chats.title MUST encrypt
console.log('4. Create chat (title encrypted at rest)');
const chatTitle = 'phase4 multi-table';
const chatRes = await jfetch('POST', '/api/chats', {
  cookie, csrf, body: { title: chatTitle },
});
ok(chatRes.status === 201, `create-chat status=${chatRes.status}`);
const chatId = chatRes.body?.chat?.id;
ok(typeof chatId === 'string' && chatId.length > 0, `chatId=${chatId}`);

const rawTitle = sql(`SELECT title FROM chats WHERE id='${chatId}';`);
ok(rawTitle.startsWith('enc:v1:'), `chats.title is sentinel (prefix=${rawTitle.slice(0, 16)}...)`);

// API GET round-trips plaintext via getUserChats
const getChats = await jfetch('GET', '/api/chats', { cookie });
ok(getChats.status === 200, `get-chats status=${getChats.status}`);
const fetchedChat = (getChats.body?.chats ?? []).find((c) => c.id === chatId);
ok(fetchedChat?.title === chatTitle, `API GET round-trips chats.title plaintext: "${fetchedChat?.title}"`);

// 5. Send a chat message — messages.content + messages.metadata MUST encrypt
console.log('5. Send chat message (content + metadata encrypted at rest)');
const sendRes = await jfetch('POST', `/api/chats/${chatId}/messages`, {
  cookie, csrf, body: { content: 'reply with the single word: ok', maxTokens: 5 },
});
if (sendRes.status !== 200) {
  console.log('   send status=', sendRes.status, 'body=', JSON.stringify(sendRes.body).slice(0, 200));
}
ok(sendRes.status === 200, `send-message status=${sendRes.status}`);

const rawRows = sql(
  `SELECT role || '|' || substr(coalesce(content,''),1,16) || '|' || substr(coalesce(metadata,''),1,16) FROM messages WHERE chat_id='${chatId}' ORDER BY created_at ASC;`
);
const lines = rawRows.split('\n').filter(Boolean);
ok(lines.length >= 1, `at least 1 raw message row (got ${lines.length})`);
for (const line of lines) {
  const [role, contentPrefix, metaPrefix] = line.split('|');
  ok(contentPrefix.startsWith('enc:v1:'), `${role}.content sentinel`);
  if (metaPrefix && metaPrefix !== '') {
    ok(metaPrefix.startsWith('enc:v1:'), `${role}.metadata sentinel`);
  }
}

const getMsgs = await jfetch('GET', `/api/chats/${chatId}/messages`, { cookie });
ok(getMsgs.status === 200, `get-messages status=${getMsgs.status}`);
const messages = getMsgs.body?.messages ?? [];
ok(messages.length >= 1, `messages length >= 1 (got ${messages.length})`);
for (const m of messages) {
  ok(typeof m.content === 'string' && !m.content.startsWith('enc:v1:'), `${m.role}.content plaintext via API`);
}

// 6. PUT /api/chats/:id — exercises outer-Proxy escape hatch for positional-arg updateChatTitle
console.log('6. PUT /api/chats/:id title (positional-arg outer-Proxy escape hatch)');
const renamedTitle = 'renamed via PUT';
const putRes = await jfetch('PUT', `/api/chats/${chatId}`, {
  cookie, csrf, body: { title: renamedTitle },
});
ok(putRes.status === 200, `put-chat status=${putRes.status}`);
const rawTitle2 = sql(`SELECT title FROM chats WHERE id='${chatId}';`);
ok(rawTitle2.startsWith('enc:v1:'), `chats.title still sentinel after PUT (prefix=${rawTitle2.slice(0, 16)}...)`);
ok(rawTitle2 !== rawTitle, 'chats.title sentinel changed (different IV/ct)');

const getChats2 = await jfetch('GET', '/api/chats', { cookie });
const fetchedChat2 = (getChats2.body?.chats ?? []).find((c) => c.id === chatId);
ok(fetchedChat2?.title === renamedTitle, `PUT round-trips plaintext: "${fetchedChat2?.title}"`);

// 7. KILL-SWITCH: disable encryption — new chat title plaintext, old still decrypts
console.log('7. KILL-SWITCH: PUT enabled=0 → new chat plaintext, old chat decrypts');
const disable = await jfetch('PUT', `/api/admin/tenant-encryption-policies/${tenantId}`, {
  cookie, csrf, body: { enabled: false },
});
ok(disable.status === 200, `disable-policy status=${disable.status}`);

const offTitle = 'after kill-switch (plaintext)';
const offChatRes = await jfetch('POST', '/api/chats', {
  cookie, csrf, body: { title: offTitle },
});
ok(offChatRes.status === 201, `kill-switch create-chat status=${offChatRes.status}`);
const offChatId = offChatRes.body?.chat?.id;
const rawOffTitle = sql(`SELECT title FROM chats WHERE id='${offChatId}';`);
ok(!rawOffTitle.startsWith('enc:v1:'), `kill-switch chats.title plaintext at rest: "${rawOffTitle}"`);
ok(rawOffTitle === offTitle, 'kill-switch raw title equals input plaintext');

// Old (encrypted) chat must still decrypt — wrapper sees `enc:v1:` prefix and decrypts regardless of policy
const getChatsOff = await jfetch('GET', '/api/chats', { cookie });
const oldStill = (getChatsOff.body?.chats ?? []).find((c) => c.id === chatId);
ok(oldStill?.title === renamedTitle, `old encrypted chat still decrypts under kill-switch: "${oldStill?.title}"`);

// 8. ROTATION: re-enable + rotate-dek → epoch advances; new write at new epoch; cross-epoch reads work
console.log('8. ROTATION: re-enable + rotate-dek → cross-epoch read works');
const reEnable = await jfetch('PUT', `/api/admin/tenant-encryption-policies/${tenantId}`, {
  cookie, csrf, body: { enabled: true },
});
ok(reEnable.status === 200, `re-enable status=${reEnable.status}`);

const epochBefore = sql(`SELECT epoch FROM tenant_deks WHERE tenant_id='${tenantId}' AND status='active' ORDER BY epoch DESC LIMIT 1;`);
const rot = await jfetch('POST', `/api/admin/tenant-encryption-policies/${tenantId}/rotate-dek`, { cookie, csrf });
ok(rot.status === 200, `rotate-dek status=${rot.status}`);
const epochAfter = sql(`SELECT epoch FROM tenant_deks WHERE tenant_id='${tenantId}' AND status='active' ORDER BY epoch DESC LIMIT 1;`);
ok(Number(epochAfter) > Number(epochBefore), `DEK epoch advanced: ${epochBefore} → ${epochAfter}`);

// Send a new message under the new epoch
const sendRes2 = await jfetch('POST', `/api/chats/${chatId}/messages`, {
  cookie, csrf, body: { content: 'say: ok', maxTokens: 5 },
});
ok(sendRes2.status === 200, `send-message-2 status=${sendRes2.status}`);
const newestUserSentinel = sql(
  `SELECT content FROM messages WHERE chat_id='${chatId}' AND role='user' ORDER BY created_at DESC LIMIT 1;`
);
const newestEpoch = newestUserSentinel.split(':')[2];
ok(newestEpoch === String(epochAfter), `newest user message epoch matches active DEK: ${newestEpoch} === ${epochAfter}`);

// Cross-epoch read: ALL messages still decrypt + chat title (encrypted under epoch 1) still decrypts
const getMsgs3 = await jfetch('GET', `/api/chats/${chatId}/messages`, { cookie });
ok(getMsgs3.status === 200, `get-messages-3 status=${getMsgs3.status}`);
const allPlain = (getMsgs3.body?.messages ?? []).every(
  (m) => typeof m.content === 'string' && !m.content.startsWith('enc:v1:')
);
ok(allPlain, 'all messages decrypt across epochs');

const getChatsCross = await jfetch('GET', '/api/chats', { cookie });
const oldChatCross = (getChatsCross.body?.chats ?? []).find((c) => c.id === chatId);
ok(oldChatCross?.title === renamedTitle, `chats.title (epoch 1) still decrypts after rotation: "${oldChatCross?.title}"`);

// 9. CLEANUP: DELETE without shred MUST return 409
console.log('9. Cleanup (shred-then-delete ordering invariant)');
const delChatA = await jfetch('DELETE', `/api/chats/${chatId}`, { cookie, csrf });
ok(delChatA.status === 200 || delChatA.status === 204, `delete-chat-A status=${delChatA.status}`);
const delChatB = await jfetch('DELETE', `/api/chats/${offChatId}`, { cookie, csrf });
ok(delChatB.status === 200 || delChatB.status === 204, `delete-chat-B status=${delChatB.status}`);

const delGuard = await jfetch('DELETE', `/api/admin/tenant-encryption-policies/${tenantId}`, { cookie, csrf });
ok(delGuard.status === 409, `delete-policy-before-shred refused status=${delGuard.status}`);

const shred = await jfetch('POST', `/api/admin/tenant-encryption-policies/${tenantId}/shred`, {
  cookie, csrf, body: { confirm: tenantId },
});
ok(shred.status === 200, `shred status=${shred.status}`);

const delPolicy = await jfetch('DELETE', `/api/admin/tenant-encryption-policies/${tenantId}`, { cookie, csrf });
ok(delPolicy.status === 200 || delPolicy.status === 204, `delete-policy status=${delPolicy.status}`);

console.log(`\n✅ All ${ok.count()} assertions passed.\n`);
