// E2E: M7 Actions tab — /api/me task + notification-action + reminder surface.
//
// Verifies, end to end, the server surface that backs the mobile Actions tab:
//   1. POST /api/me/tasks (actionable)            seeds an *approval*; data.actionable=true persists
//   2. POST /api/me/tasks (plain)                 seeds an *action item*; data.actionable=false
//   3. GET  /api/me/tasks                         lists both, with the approval/action split grounded in data
//   4. POST /api/me/notifications/actions approve resolves an approval → status 'completed'
//   5. (double-tap)                               same approval again → one decision (idempotent, alreadyResolved)
//   6. POST /api/me/notifications/actions deny    a second approval → status 'rejected'
//   7. POST /api/me/tasks/:id/complete            an action item → 'completed'
//   8. POST /api/me/tasks/:id/cancel              a task → 'rejected'
//   9. validation + isolation                     bad actionId → 400; unknown id → 404
//  10. provenance                                 sourceRunId round-trips (the row's deep-link target)
//  11. POST /api/me/reminders                     creates a one-shot reminder (source.config.fireAt, metadata.label)
//  12. GET  /api/me/reminders                     lists it
//  13. POST /api/me/reminders/:id/reschedule      snooze updates fireAt + re-enables
//  14. reschedule validation                      missing fireAt → 400; unknown id → 404
//  15. DELETE /api/me/reminders/:id               removes it; double-delete → 404
//
// Self-contained: the task + reminder stores are IN-MEMORY (per server process),
// so there is no SQL seed/cleanup. Everything is created through the authenticated
// API under a unique run TAG and cleaned up afterwards (tasks driven to terminal
// state, reminders deleted). A plain tenant_user owns its own tasks/reminders.
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://localhost:3500';
const EMAIL = process.env.EMAIL ?? 'tester@geneweave.local';
const PASS = process.env.PASS ?? 'Testpass123!';

// A real seeded conversation id for this user — proves the deep-link target
// (provenance.sourceRunId) survives the round-trip into the Actions surface.
const CONV_ID = process.env.CONV_ID ?? 'mob_382dacd40bd15efc6835c166b774';

const TAG = `e2e-m7-${randomUUID().slice(0, 8)}`;

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  // ── auth ────────────────────────────────────────────────────────────────
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status} ${await loginRes.text()}`);
  const login = await loginRes.json();
  const setCookie = loginRes.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(',').map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
  if (!cookie) throw new Error('no session cookie');
  const auth = { Cookie: cookie, 'X-CSRF-Token': login.csrfToken, 'Content-Type': 'application/json' };

  const req = async (path, init = {}) => {
    const r = await fetch(`${BASE}${path}`, { headers: auth, ...init });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };

  // Track what we create so we can drive it to a terminal/deleted state at the end.
  const createdReminders = [];

  try {
    // ── 1. seed an approval (actionable:true, with a deep-link provenance) ─────
    console.log('\n[1] POST /api/me/tasks (approval — actionable:true)');
    const approvalRes = await req('/api/me/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: `${TAG} approve the rollout`,
        description: 'Requires an explicit approve/deny.',
        actionable: true,
        provenance: { sourceRunId: CONV_ID, createdBy: 'agent' },
      }),
    });
    assert(approvalRes.status === 201, `approval created (${approvalRes.status})`);
    const approval = approvalRes.body;
    assert(approval.data && approval.data.actionable === true, 'approval persists data.actionable=true');
    assert(approval.provenance?.sourceRunId === CONV_ID, 'approval provenance.sourceRunId round-trips (deep-link)');

    // ── 2. seed a plain action item (no actionable flag) ──────────────────────
    console.log('\n[2] POST /api/me/tasks (action item — plain)');
    const dueAt = new Date(Date.now() + 3 * 3600_000).toISOString();
    const itemRes = await req('/api/me/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: `${TAG} draft the summary`, dueAt }),
    });
    assert(itemRes.status === 201, `action item created (${itemRes.status})`);
    const item = itemRes.body;
    assert(item.data && item.data.actionable === false, 'action item persists data.actionable=false');
    assert(item.dueAt === dueAt, 'action item dueAt round-trips');

    // ── 3. list shows both, split by the persisted flag ───────────────────────
    console.log('\n[3] GET /api/me/tasks (approval vs action-item split)');
    const list = await req('/api/me/tasks');
    assert(list.status === 200 && Array.isArray(list.body.tasks), `tasks listed (${list.status})`);
    const mine = list.body.tasks.filter((t) => typeof t.title === 'string' && t.title.startsWith(TAG));
    assert(mine.length === 2, `both seeded tasks listed (got ${mine.length})`);
    const gotApproval = mine.find((t) => t.id === approval.id);
    const gotItem = mine.find((t) => t.id === item.id);
    assert(gotApproval?.data?.actionable === true, 'listed approval keeps data.actionable=true');
    assert(gotItem?.data?.actionable === false, 'listed action item keeps data.actionable=false');
    assert(gotApproval?.provenance?.sourceRunId === CONV_ID, 'listed approval keeps its deep-link provenance');

    // ── 4. approve the approval → resolved + completed ────────────────────────
    console.log('\n[4] POST /api/me/notifications/actions (approve)');
    const approveRes = await req('/api/me/notifications/actions', {
      method: 'POST',
      body: JSON.stringify({ taskId: approval.id, actionId: 'approve' }),
    });
    assert(approveRes.status === 200, `approve ok (${approveRes.status})`);
    assert(approveRes.body.resolved === true && approveRes.body.status === 'completed', 'approve resolves to completed');

    // ── 5. double-tap the same approval → ONE decision (idempotent) ───────────
    console.log('\n[5] POST /api/me/notifications/actions (double-tap — idempotency)');
    const again = await req('/api/me/notifications/actions', {
      method: 'POST',
      body: JSON.stringify({ taskId: approval.id, actionId: 'approve' }),
    });
    assert(again.status === 200, `second tap still 200 (${again.status})`);
    assert(again.body.alreadyResolved === true && again.body.status === 'completed',
      'double-tap is idempotent (alreadyResolved, still completed)');
    // A contradictory deny after resolution must NOT flip the outcome.
    const contradict = await req('/api/me/notifications/actions', {
      method: 'POST',
      body: JSON.stringify({ taskId: approval.id, actionId: 'deny' }),
    });
    assert(contradict.body.alreadyResolved === true && contradict.body.status === 'completed',
      'a late deny cannot override an already-completed approval (one decision wins)');

    // ── 6. deny a second approval → rejected ──────────────────────────────────
    console.log('\n[6] POST /api/me/notifications/actions (deny)');
    const approval2 = (await req('/api/me/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: `${TAG} reject me`, actionable: true, provenance: { sourceRunId: CONV_ID, createdBy: 'agent' } }),
    })).body;
    const denyRes = await req('/api/me/notifications/actions', {
      method: 'POST',
      body: JSON.stringify({ taskId: approval2.id, actionId: 'deny' }),
    });
    assert(denyRes.status === 200 && denyRes.body.resolved === true && denyRes.body.status === 'rejected',
      'deny resolves to rejected');

    // ── 7. complete the plain action item ─────────────────────────────────────
    console.log('\n[7] POST /api/me/tasks/:id/complete');
    const completed = await req(`/api/me/tasks/${item.id}/complete`, { method: 'POST', body: '{}' });
    assert(completed.status === 200 && completed.body.status === 'completed', 'action item completes');

    // ── 8. cancel a fresh task ────────────────────────────────────────────────
    console.log('\n[8] POST /api/me/tasks/:id/cancel');
    const toCancel = (await req('/api/me/tasks', {
      method: 'POST', body: JSON.stringify({ title: `${TAG} dismiss me` }),
    })).body;
    const cancelled = await req(`/api/me/tasks/${toCancel.id}/cancel`, { method: 'POST', body: '{}' });
    assert(cancelled.status === 200 && cancelled.body.status === 'rejected', 'task cancels to rejected');

    // ── 9. validation + cross-id isolation ────────────────────────────────────
    console.log('\n[9] notification-action validation + isolation');
    const badAction = await req('/api/me/notifications/actions', {
      method: 'POST', body: JSON.stringify({ taskId: approval2.id, actionId: 'maybe' }),
    });
    assert(badAction.status === 400, `non approve/deny actionId rejected (${badAction.status})`);
    const missingTask = await req('/api/me/notifications/actions', {
      method: 'POST', body: JSON.stringify({ taskId: `nope-${randomUUID()}`, actionId: 'approve' }),
    });
    assert(missingTask.status === 404, `unknown taskId is 404 (${missingTask.status})`);
    const completeMissing = await req(`/api/me/tasks/nope-${randomUUID()}/complete`, { method: 'POST', body: '{}' });
    assert(completeMissing.status === 404, `completing unknown task is 404 (${completeMissing.status})`);

    // ── 11. create a one-shot reminder (with a deep-link provenance) ──────────
    console.log('\n[11] POST /api/me/reminders');
    const fireAt = new Date(Date.now() + 3600_000).toISOString();
    const remRes = await req('/api/me/reminders', {
      method: 'POST',
      body: JSON.stringify({ label: `${TAG} standup`, fireAt, provenance: { sourceRunId: CONV_ID } }),
    });
    assert(remRes.status === 201, `reminder created (${remRes.status})`);
    const reminder = remRes.body;
    createdReminders.push(reminder.id);
    assert(reminder.source?.config?.fireAt === fireAt, 'reminder stores fireAt in source.config');
    assert(reminder.metadata?.label === `${TAG} standup`, 'reminder label persists in metadata');
    assert(reminder.metadata?.oneShot === true, 'fireAt reminder is one-shot');
    assert(reminder.enabled === true, 'reminder starts enabled');
    assert(reminder.provenance?.sourceRunId === CONV_ID, 'reminder provenance.sourceRunId round-trips (deep-link)');

    // ── 12. list reminders ────────────────────────────────────────────────────
    console.log('\n[12] GET /api/me/reminders');
    const rlist = await req('/api/me/reminders');
    assert(rlist.status === 200 && Array.isArray(rlist.body.reminders), `reminders listed (${rlist.status})`);
    const mineRem = rlist.body.reminders.filter((r) => r.metadata?.label?.startsWith(TAG));
    assert(mineRem.some((r) => r.id === reminder.id), 'created reminder appears in the list');

    // ── 13. snooze (reschedule) → fireAt updated, re-enabled ──────────────────
    console.log('\n[13] POST /api/me/reminders/:id/reschedule (snooze)');
    const snoozeAt = new Date(Date.now() + 2 * 3600_000).toISOString();
    const resched = await req(`/api/me/reminders/${reminder.id}/reschedule`, {
      method: 'POST', body: JSON.stringify({ fireAt: snoozeAt }),
    });
    assert(resched.status === 200, `reschedule ok (${resched.status})`);
    assert(resched.body.source?.config?.fireAt === snoozeAt, 'reschedule updates fireAt');
    assert(resched.body.enabled === true, 'reschedule re-enables the reminder');

    // ── 14. reschedule validation + isolation ─────────────────────────────────
    console.log('\n[14] reschedule validation + isolation');
    const noFire = await req(`/api/me/reminders/${reminder.id}/reschedule`, { method: 'POST', body: '{}' });
    assert(noFire.status === 400, `reschedule without fireAt rejected (${noFire.status})`);
    const reschedMissing = await req(`/api/me/reminders/nope-${randomUUID()}/reschedule`, {
      method: 'POST', body: JSON.stringify({ fireAt: snoozeAt }),
    });
    assert(reschedMissing.status === 404, `rescheduling unknown reminder is 404 (${reschedMissing.status})`);

    // ── 15. delete reminder; double-delete → 404 ──────────────────────────────
    console.log('\n[15] DELETE /api/me/reminders/:id');
    const del = await req(`/api/me/reminders/${reminder.id}`, { method: 'DELETE' });
    assert(del.status === 200 && del.body.deleted === true, 'reminder deleted');
    createdReminders.length = 0; // already gone
    const gone = (await req('/api/me/reminders')).body.reminders.filter((r) => r.id === reminder.id);
    assert(gone.length === 0, 'deleted reminder no longer listed');
    const delAgain = await req(`/api/me/reminders/${reminder.id}`, { method: 'DELETE' });
    assert(delAgain.status === 404, `double-delete is 404 (${delAgain.status})`);

    console.log('\n✅ M7 actions e2e passed');
  } finally {
    // In-memory stores: nothing to drop from SQL. Best-effort delete any reminder
    // we created but did not already remove (tasks are left in their terminal
    // state — there is no task-delete endpoint, and terminal tasks fall out of the
    // open/approval views the UI renders).
    for (const id of createdReminders) {
      await req(`/api/me/reminders/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    if (createdReminders.length) console.log('  ✓ cleaned up leftover reminders');
  }
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
