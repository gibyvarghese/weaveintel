#!/usr/bin/env node
// scripts/e2e-m2-api-client.mjs
//
// M2 (@geneweave/api-client) — live-server end-to-end proof that the BUILT
// typed client drives the real /api/me surface exactly as geneweave-mobile will.
// Unlike the SP1/SP2 scripts (raw fetch), this imports the compiled package and
// exercises it through its public API only.
//
//   1. authenticate()            → captures bearer + CSRF into the TokenStore
//   2. getCurrentUser()          → same principal via the stored bearer
//   3. AuthExpiredError          → a client with a bad token + no refresh throws it
//   4. startRun() + attachRun()  → run reaches a terminal view model over SSE
//   5. resume via afterSequence  → re-attach replays only events after the cursor
//                                  (the zero-gap server semantics resume relies on)
//   6. getCatalog('mobile')      → surface catalog resolves
//   7. tasks create + complete   → mutation honoured; second complete is idempotent
//                                  or cleanly rejected (never a 5xx)
//   8. memory create/list/correct/delete → full CRUD round-trip
//   9. per-tenant isolation      → two clients, same host, namespaced outboxes
//
// Usage: zsh> set +H && BASE_URL=http://localhost:3500 node scripts/e2e-m2-api-client.mjs
import { BASE, makeOk, jfetch } from './e2e-helpers.mjs';
import {
  createGeneweaveClient,
  MemoryTokenStore,
  AuthExpiredError,
  MemoryStorage,
} from '../clients/api-client/dist/index.js';

const ok = makeOk();
const ts = Date.now();
const password = 'P@ssw0rd123';
const email = `e2e_m2_${ts}@example.com`;

console.log(`\n=== M2 api-client E2E — ${BASE} ===\n`);

// 0. Seed a principal via the cookie-register path (not part of the client surface).
console.log('0. Seed a principal so credentials exist');
const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'm2' } });
ok(reg.status === 201, `register status=${reg.status}`);

const tokenStore = new MemoryTokenStore();
const client = createGeneweaveClient({ host: BASE, tokenStore });

// 1. authenticate()
console.log('\n1. authenticate() captures the bearer + CSRF tokens');
const session = await client.authenticate(email, password);
ok(session.user.email === email, 'authenticate resolves the principal');
const stored = await tokenStore.get();
ok(stored?.token?.split('.').length === 3 && typeof stored.csrfToken === 'string', 'tokens persisted to the TokenStore');

// 2. getCurrentUser()
console.log('\n2. getCurrentUser() authenticates via the stored bearer');
const me = await client.getCurrentUser();
ok(me.email === email, 'getCurrentUser resolves the same principal');

// 3. AuthExpiredError
console.log('\n3. A client with a bad token and no refresh throws AuthExpiredError');
const badClient = createGeneweaveClient({
  host: BASE,
  tokenStore: new MemoryTokenStore({ token: 'not.a.real.jwt', csrfToken: 'x' }),
});
let threwAuth = false;
try {
  await badClient.getCurrentUser();
} catch (err) {
  threwAuth = err instanceof AuthExpiredError;
}
ok(threwAuth, 'AuthExpiredError thrown on an unrecoverable 401');

// 4. startRun() + postEvent() lifecycle + attachRun() → terminal view model.
//    NOTE: at this milestone POST /api/me/runs creates a `pending` run row; the
//    agent executor that auto-emits run.* events is a later server milestone.
//    M2 (the client) owns posting events, attaching, reducing, and resuming —
//    so we drive the lifecycle through the client's own postEvent() and prove
//    the stream + reducer + cursor semantics end-to-end.
console.log('\n4. startRun() + postEvent() + attachRun() reduces the SSE stream to a terminal state');
const run = await client.startRun({ idempotencyKey: `m2-${ts}`, surface: 'mobile', input: { prompt: 'ping' } });
ok(typeof run.id === 'string', `run started id=${run.id}`);

const s0 = await client.postEvent(run.id, { kind: 'run.started' });
const s1 = await client.postEvent(run.id, { kind: 'text.delta', payload: { text: 'hello world' } });
const s2 = await client.postEvent(run.id, { kind: 'run.completed' });
ok(s0.sequence === 0 && s1.sequence === 1 && s2.sequence === 2, `events appended with monotonic sequences [${s0.sequence},${s1.sequence},${s2.sequence}]`);

function attachToTerminal(runId, attachOpts = {}) {
  return new Promise((resolve, reject) => {
    const seqs = [];
    const timer = setTimeout(() => reject(new Error('attach timed out before terminal')), 20000);
    client.attachRun(runId, {
      ...attachOpts,
      onEvent: (e) => seqs.push(e.sequence),
      onComplete: (vm) => {
        clearTimeout(timer);
        resolve({ seqs, vm });
      },
      onError: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
  });
}

const first = await attachToTerminal(run.id);
ok(JSON.stringify(first.seqs) === JSON.stringify([0, 1, 2]), `received events in order [${first.seqs.join(',')}]`);
ok(first.vm.status === 'completed', `run reduced to a terminal view-model status=${first.vm.status}`);

// 5. resume via afterSequence — re-attach replays ONLY events after the cursor.
console.log('\n5. Re-attach with afterSequence replays only the tail (zero-gap resume semantics)');
const cursor = 0;
const second = await attachToTerminal(run.id, { afterSequence: cursor });
ok(JSON.stringify(second.seqs) === JSON.stringify([1, 2]), `replay after ${cursor} == tail [${second.seqs.join(',')}]`);
ok(second.seqs.every((s) => s > cursor), 'replayed events are all strictly after the cursor');
ok(second.vm.status === 'completed', 'resumed stream still reaches the terminal state');

// 6. catalog
console.log('\n6. getCatalog("mobile") resolves the surface catalog');
const catalog = await client.getCatalog('mobile');
ok(typeof catalog.surfaceId === 'string', `catalog surfaceId=${catalog.surfaceId}`);
ok(Array.isArray(catalog.starterPrompts), 'starterPrompts is an array');

// 7. tasks create + complete + idempotent second complete
console.log('\n7. Task create + complete; second complete is idempotent or cleanly rejected');
const task = await client.createTask({ title: `M2 task ${ts}`, description: 'e2e' });
ok(typeof task.id === 'string', `task created id=${task.id}`);
const completed = await client.completeTask(task.id);
ok(completed.id === task.id, `task completed status=${completed.status}`);
let secondCompleteSafe = false;
try {
  const again = await client.completeTask(task.id);
  secondCompleteSafe = typeof again.status === 'string'; // idempotent success
} catch (err) {
  // A 4xx rejection is acceptable; a 5xx is not.
  secondCompleteSafe = err?.status >= 400 && err?.status < 500;
}
ok(secondCompleteSafe, 'double-complete is idempotent or a clean 4xx (never a 5xx)');

// 8. memory CRUD
console.log('\n8. Memory create → list → correct → delete round-trip');
const mem = await client.createMemory({ content: `m2 remembers ${ts}` });
ok(typeof mem.id === 'string', `memory created id=${mem.id}`);
const memories = await client.listMemories();
const all = [
  ...memories.memories.semantic,
  ...memories.memories.entity,
  ...memories.memories['user-authored'],
];
ok(all.some((m) => m.id === mem.id), 'created memory appears in the list');
const corrected = await client.correctMemory(mem.id, { content: `m2 corrected ${ts}`, reason: 'e2e' });
ok(typeof corrected.id === 'string', 'memory corrected');
await client.deleteMemory(corrected.id);
ok(true, 'memory deleted without error');

// 9. per-tenant isolation
console.log('\n9. Per-tenant outbox isolation on a single host');
const shared = new MemoryStorage();
const tenantA = createGeneweaveClient({ host: BASE, tokenStore: new MemoryTokenStore(), outboxStorage: shared, namespace: 'tenant-a' });
const tenantB = createGeneweaveClient({ host: BASE, tokenStore: new MemoryTokenStore(), outboxStorage: shared, namespace: 'tenant-b' });
await tenantA.enqueueRun({ idempotencyKey: 'a-1', surface: 'mobile' });
await tenantB.enqueueRun({ idempotencyKey: 'b-1', surface: 'mobile' });
const aPending = await tenantA.outbox.pending();
const bPending = await tenantB.outbox.pending();
ok(aPending.length === 1 && aPending[0].input.idempotencyKey === 'a-1', 'tenant-a outbox isolated');
ok(bPending.length === 1 && bPending[0].input.idempotencyKey === 'b-1', 'tenant-b outbox isolated');
ok(shared.keys().some((k) => k.startsWith('tenant-a::')) && shared.keys().some((k) => k.startsWith('tenant-b::')), 'storage keys namespaced per tenant');

console.log(`\n=== M2 api-client E2E PASSED — ${ok.count()} assertions ===\n`);
