/**
 * Example 115 — Multi-Agent Collaboration: Sessions, Events, Subscriptions & Handoffs
 *
 * Runs entirely in-memory. No API keys, no external services, no WebSocket server.
 *
 * The problem @weaveintel/collaboration solves
 * ─────────────────────────────────────────────
 * Long-running, multi-agent workflows need shared coordination state:
 *
 *   • Multiple users (human or AI) often watch or participate in the same
 *     run simultaneously. Without a session abstraction, you cannot track
 *     who is present, who is typing, or who left — making it impossible to
 *     show real-time presence indicators in a UI.
 *
 *   • Agent A may need to hand control to Agent B mid-run (e.g. because the
 *     task requires a specialised skill or elevated permissions). Without a
 *     structured handoff, the transition is implicit and unauditable.
 *
 *   • Subscribers (dashboards, downstream agents, webhooks) need to know
 *     a run's progress without polling. A subscription manager lets them
 *     register interest and receive structured status updates.
 *
 * @weaveintel/collaboration provides four composable pieces:
 *
 *   SharedSessionManager  — create sessions, add/remove participants, update
 *     presence (online/idle/typing/away/offline), broadcast updates.
 *
 *   CollaborationEvent    — typed event values (createCollaborationEvent),
 *     with isPresenceEvent() and isHandoffEvent() type guards.
 *
 *   RunSubscriptionManager — subscribe to a run, broadcast status updates
 *     (pending → running → completed), unsubscribe.
 *
 *   HandoffManager        — request a handoff between agents, accept or
 *     reject it, query current status.
 *
 * Packages used:
 *   @weaveintel/collaboration — createSharedSessionManager,
 *     createCollaborationEvent, isPresenceEvent, isHandoffEvent,
 *     createRunSubscriptionManager, createHandoffManager
 *
 * No API keys needed — all state lives in-process Maps.
 *
 * Run: npx tsx examples/115-collaboration.ts
 */

import {
  // Session management
  createSharedSessionManager,
  type SharedSession,
  type PresenceState,
  // Run subscriptions
  createRunSubscriptionManager,
  type RunStatus,
  // Handoff management
  createHandoffManager,
  type HandoffStatus,
} from '@weaveintel/collab';

/* ─── Section header helpers ─────────────────────────────────────────────── */

function header(title: string): void {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(64));
}

function ok(msg: string): void   { console.log(`  ✓ ${msg}`); }
function info(msg: string): void { console.log(`  ℹ ${msg}`); }

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 1 — SharedSessionManager: create, join, presence, get
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateSession(): Promise<void> {
  header('1. SharedSessionManager — Sessions & Presence');

  // createSharedSessionManager() returns an in-memory manager.
  // Each SharedSession is an immutable snapshot; mutating calls return
  // a fresh snapshot so callers always get a consistent view.
  const manager = createSharedSessionManager();

  // --- 1a. create() — spawn a new session -----------------------------
  // The creator automatically becomes the 'owner' participant with
  // presence='online'. metadata is open-ended for application-specific
  // context (e.g. taskId, runId, tenant).
  const session: SharedSession = manager.create(
    'Q3 Planning Analysis',           // human-readable session name
    'user-alice',                     // createdBy — becomes the owner
    { taskId: 'task-q3', runId: 'run-001' },  // arbitrary metadata
  );

  info(`Session id:         ${session.id}`);
  info(`Session name:       "${session.name}"`);
  info(`Created by:         ${session.createdBy}`);
  info(`Initial participants: ${session.participants.length} (owner only)`);
  if (session.participants.length !== 1) throw new Error('Expected 1 initial participant (owner)');
  if (session.participants[0]?.role !== 'owner') throw new Error('First participant should be owner');
  if (session.participants[0]?.presence !== 'online') throw new Error('Owner should start online');
  ok('Session created; owner auto-joined as "online" participant');

  // --- 1b. join() — add more participants ------------------------------
  // join() takes a session id and a participant descriptor (everything
  // except joinedAt and lastActiveAt, which are stamped by the manager).
  const afterBobJoin = manager.join(session.id, {
    userId:      'user-bob',
    displayName: 'Bob the Reviewer',
    role:        'collaborator',
    presence:    'online',
  });

  const afterEveJoin = manager.join(session.id, {
    userId:      'user-eve',
    displayName: 'Eve (Observer)',
    role:        'viewer',
    presence:    'away',
  });

  info(`\nAfter joins — participants: ${afterEveJoin.participants.length}`);
  for (const p of afterEveJoin.participants) {
    info(`  [${p.role}] ${p.userId} — presence: ${p.presence}`);
  }
  if (afterEveJoin.participants.length !== 3) throw new Error('Expected 3 participants');
  ok('join() added Bob (collaborator) and Eve (viewer) to the session');

  // --- 1c. updatePresence() — reflect real-time activity ---------------
  // Called when a user's client sends a "typing" event, or an idle timeout
  // fires, or a user closes their browser tab.
  const afterBobTypes = manager.updatePresence(session.id, 'user-bob', 'typing');
  const bobParticipant = afterBobTypes.participants.find(p => p.userId === 'user-bob');
  info(`\nBob's presence after update: ${bobParticipant?.presence}`);
  if (bobParticipant?.presence !== 'typing') throw new Error('Expected Bob to be "typing"');
  ok('updatePresence() updated Bob from "online" to "typing"');

  // Update Alice to idle (she stepped away).
  manager.updatePresence(session.id, 'user-alice', 'idle');
  ok('updatePresence() updated Alice to "idle"');

  // --- 1d. get() — retrieve the current snapshot ----------------------
  // get() always returns a fresh immutable snapshot of participants,
  // useful for UI renders and REST GET endpoints.
  const snapshot = manager.get(session.id);
  if (!snapshot) throw new Error('Session should exist');
  info(`\nCurrent snapshot — participants: ${snapshot.participants.length}`);
  const alice = snapshot.participants.find(p => p.userId === 'user-alice');
  info(`Alice presence: ${alice?.presence}`);
  if (alice?.presence !== 'idle') throw new Error('Expected Alice to be idle in snapshot');
  ok('get() returned a fresh snapshot reflecting all presence updates');

  // --- 1e. leave() — participant departs the session ------------------
  const afterLeave = manager.leave(session.id, 'user-eve');
  info(`\nAfter Eve leaves — participants: ${afterLeave.participants.length}`);
  if (afterLeave.participants.length !== 2) throw new Error('Expected 2 participants after Eve leaves');
  ok('leave() removed Eve; 2 participants remain');

  // --- 1f. listSessions() — enumerate all open sessions ---------------
  // Create a second session to show listSessions() sees both.
  manager.create('Code Review Session', 'user-charlie');
  const allSessions = manager.listSessions();
  info(`\nTotal open sessions: ${allSessions.length}`);
  if (allSessions.length !== 2) throw new Error('Expected 2 sessions');
  ok('listSessions() returns both open sessions');

  // close() removes the session entirely (e.g. when a run finishes).
  manager.close(session.id);
  const afterClose = manager.get(session.id);
  info(`get() after close() → ${afterClose}`);
  if (afterClose !== undefined) throw new Error('Closed session should not be retrievable');
  ok('close() removed session; get() now returns undefined');
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 2 — RunSubscriptionManager: subscribe, status updates, unsubscribe
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateSubscriptions(): Promise<void> {
  header('3. RunSubscriptionManager — Subscribe, Broadcast, Unsubscribe');

  // createRunSubscriptionManager() maintains a Map of RunSubscription objects
  // keyed by "{runId}:{subscriberId}". Multiple subscribers can watch the
  // same run; updateStatus() broadcasts to all of them simultaneously.
  const subManager = createRunSubscriptionManager();

  const RUN_ID     = 'run-pipeline-42';
  const SESSION_ID = 'sess-demo-001';

  // --- 3a. subscribe() — register interest in a run --------------------
  // Returns a RunSubscription with status='pending', progress=0.
  const sub1 = subManager.subscribe(RUN_ID, SESSION_ID, 'subscriber-dashboard');
  const sub2 = subManager.subscribe(RUN_ID, SESSION_ID, 'subscriber-agent-b');

  info(`Subscriber 1: runId=${sub1.runId}, subscriber=${sub1.subscriberId}, status=${sub1.status}`);
  info(`Subscriber 2: runId=${sub2.runId}, subscriber=${sub2.subscriberId}, status=${sub2.status}`);
  if (sub1.status !== 'pending') throw new Error('Expected initial status pending');
  if (sub1.progress !== 0)       throw new Error('Expected initial progress 0');
  ok('subscribe() created two subscriptions with status=pending and progress=0');

  // --- 3b. updateStatus() — broadcast a status change to all subscribers
  // updateStatus() iterates all subscriptions matching the runId and updates
  // each one, so both the dashboard and Agent B see the same state.
  const progressSteps: Array<{ status: RunStatus; progress: number; label: string }> = [
    { status: 'running',   progress: 0.0,  label: 'run started' },
    { status: 'running',   progress: 0.3,  label: 'stage 1 done' },
    { status: 'running',   progress: 0.7,  label: 'stage 2 done' },
    { status: 'completed', progress: 1.0,  label: 'all stages done' },
  ];

  for (const step of progressSteps) {
    // updateStatus() returns one of the updated subscriptions (any of them,
    // since they all get the same status/progress after the call).
    const updated = subManager.updateStatus(RUN_ID, step.status, step.progress);
    info(`  [${step.label}] status=${updated?.status}, progress=${updated?.progress}`);
  }
  ok('updateStatus() broadcast all four progress steps across both subscribers');

  // --- 3c. getSubscription() — retrieve an individual subscription ------
  const dashSub = subManager.getSubscription(RUN_ID, 'subscriber-dashboard');
  info(`\nDashboard subscription final state: status=${dashSub?.status}, progress=${dashSub?.progress}`);
  if (dashSub?.status !== 'completed') throw new Error('Dashboard sub should be completed');
  if (dashSub?.progress !== 1.0)       throw new Error('Dashboard sub should have progress=1.0');
  ok('getSubscription() returned the final state for the dashboard subscriber');

  // --- 3d. listBySession() — all subscriptions for a session ---------------
  // Useful for rendering a "running jobs" panel in the session UI.
  const sessionSubs = subManager.listBySession(SESSION_ID);
  info(`listBySession("${SESSION_ID}") → ${sessionSubs.length} subscription(s)`);
  if (sessionSubs.length !== 2) throw new Error('Expected 2 subscriptions for this session');
  ok('listBySession() returned both subscriptions for the session');

  // --- 3e. unsubscribe() — remove a specific subscriber ----------------
  subManager.unsubscribe(RUN_ID, 'subscriber-agent-b');
  const agentBSub = subManager.getSubscription(RUN_ID, 'subscriber-agent-b');
  info(`getSubscription after unsubscribe → ${agentBSub}`);
  if (agentBSub !== undefined) throw new Error('Expected undefined after unsubscribe');
  ok('unsubscribe() removed agent-b; getSubscription() now returns undefined');

  // Dashboard subscription still intact.
  const remainingSubs = subManager.listBySession(SESSION_ID);
  info(`Remaining subscriptions: ${remainingSubs.length}`);
  if (remainingSubs.length !== 1) throw new Error('Expected 1 subscription remaining');
  ok('Dashboard subscription intact after agent-b unsubscribed');
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 4 — HandoffManager: request, accept, get status
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateHandoff(): Promise<void> {
  header('4. HandoffManager — Initiate, Accept, Query, Reject');

  // createHandoffManager() stores HandoffRequests keyed by generated id.
  // A handoff represents a deliberate, auditable transfer of control from
  // one agent (or user) to another within a session.
  const hm = createHandoffManager();

  const SESSION_ID = 'sess-multi-agent-1';

  // --- 4a. request() — initiate a handoff --------------------------------
  // agent-researcher has completed its phase and wants agent-coder to take over.
  // The 'reason' field is logged and surfaced in audit trails.
  const handoff1 = hm.request(
    SESSION_ID,
    'agent-researcher',     // fromUserId (the agent relinquishing control)
    'agent-coder',          // toUserId   (the agent receiving control)
    'Research phase complete; code generation required for API scaffolding',
  );

  info(`Handoff id:         ${handoff1.id}`);
  info(`From:               ${handoff1.fromUserId}`);
  info(`To:                 ${handoff1.toUserId}`);
  info(`Status:             ${handoff1.status}`);
  info(`Reason:             "${handoff1.reason}"`);
  info(`resolvedAt:         ${handoff1.resolvedAt}`);
  if (handoff1.status !== 'requested') throw new Error('Expected status=requested');
  if (handoff1.resolvedAt !== null)    throw new Error('resolvedAt should be null until resolved');
  ok('request() created handoff with status=requested and resolvedAt=null');

  // --- 4b. accept() — agent-coder accepts the handoff -------------------
  // accept() sets status='accepted' and stamps resolvedAt.
  const accepted = hm.accept(handoff1.id);
  info(`\nAfter accept() — status: ${accepted?.status}, resolvedAt: ${accepted?.resolvedAt}`);
  if (!accepted)                           throw new Error('Expected accept to return the handoff');
  if (accepted.status !== 'accepted')      throw new Error('Expected status=accepted');
  if (accepted.resolvedAt === null)        throw new Error('resolvedAt should be stamped on accept');
  ok('accept() transitioned status to "accepted" and stamped resolvedAt');

  // --- 4c. complete() — mark the handoff as fully resolved -------------
  // After agent-coder finishes its work, it calls complete() to close the loop.
  const completed = hm.complete(handoff1.id);
  info(`After complete() — status: ${completed?.status}`);
  if (completed?.status !== 'completed') throw new Error('Expected status=completed');
  ok('complete() transitioned status from "accepted" to "completed"');

  // --- 4d. request() + reject() — a rejected handoff scenario ----------
  // agent-coder is overloaded and rejects a second handoff from agent-analyst.
  const handoff2 = hm.request(
    SESSION_ID,
    'agent-analyst',
    'agent-coder',
    'Needs code review for the retrieval module',
  );
  info(`\nNew handoff requested: ${handoff2.id.slice(0, 8)}… status=${handoff2.status}`);

  const rejected = hm.reject(handoff2.id);
  info(`After reject() — status: ${rejected?.status}`);
  if (rejected?.status !== 'rejected') throw new Error('Expected status=rejected');
  ok('reject() transitioned status to "rejected"');

  // --- 4e. get() — retrieve a handoff by id ----------------------------
  // get() is the audit read; it returns the current state without
  // modifying it, useful for status dashboards and policy checks.
  const fetched = hm.get(handoff1.id);
  info(`\nget(handoff1.id) → status=${fetched?.status}`);
  if (fetched?.status !== 'completed') throw new Error('Fetched handoff should be completed');
  ok('get() returns the correct current state for a completed handoff');

  // --- 4f. listBySession() — all handoffs for a session ----------------
  // Useful for rendering a handoff timeline in a session audit view.
  const sessionHandoffs = hm.listBySession(SESSION_ID);
  info(`listBySession("${SESSION_ID}") → ${sessionHandoffs.length} handoff(s)`);
  if (sessionHandoffs.length !== 2) throw new Error('Expected 2 handoffs for this session');
  for (const h of sessionHandoffs) {
    info(`  [${h.status}] ${h.fromUserId} → ${h.toUserId}: "${h.reason.slice(0, 40)}…"`);
  }
  ok('listBySession() returned both handoffs with their current statuses');

  // --- 4g. cancel() — withdraw a pending handoff before it is resolved ---
  const handoff3 = hm.request(
    SESSION_ID,
    'agent-planner',
    'agent-executor',
    'Pass execution context to the executor agent',
  );
  const cancelled = hm.cancel(handoff3.id);
  info(`\nCancel pending handoff: status=${cancelled?.status}`);
  if (cancelled?.status !== 'cancelled') throw new Error('Expected status=cancelled');
  ok('cancel() set status to "cancelled" for a pending handoff');
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN
   ═══════════════════════════════════════════════════════════════════════════ */

async function main(): Promise<void> {
  console.log('\n@weaveintel/collaboration — Example 115');
  console.log('Multi-agent collaboration: sessions, events, subscriptions, handoffs');

  await demonstrateSession();
  await demonstrateSubscriptions();
  await demonstrateHandoff();

  header('All sections complete');
  console.log('  ✓ SharedSessionManager: create, join, presence, get, leave, list, close');
  console.log('  ✓ RunSubscriptionManager: subscribe, updateStatus, list, unsubscribe');
  console.log('  ✓ HandoffManager: request, accept, complete, reject, cancel, get, list');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
