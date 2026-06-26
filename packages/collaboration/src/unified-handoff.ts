// SPDX-License-Identifier: MIT
/**
 * @weaveintel/collaboration — Unified handoff (Collaboration Phase 5).
 *
 * ONE durable, audited handoff lifecycle that reconciles the three scopes that
 * previously lived apart:
 *   - user → user   (hand a live session to a teammate),
 *   - agent → human (an AI run escalates to a person who takes over, then hands back),
 *   - agent → agent (delegate to another agent).
 *
 * --- For someone new to this ---
 * A "handoff" is passing the baton. A long task is running and whoever (or
 * whatever) holds it wants someone else to take over: a colleague, a human
 * expert, or another AI. This models that as a small, explicit lifecycle —
 * REQUESTED, then ACCEPTED or REJECTED, then IN PROGRESS while the new owner
 * works, then HANDED BACK and COMPLETED — and writes down EVERY step (who, when,
 * why) so there is a clear audit trail. Critically, a rejection must say WHY.
 *
 * Design (mid-2026 research — OpenAI Agents SDK handoffs, LangGraph interrupts,
 * A2A v1.0 task lifecycle, EU AI Act Art. 12/14 audit + human-oversight):
 *  - **Explicit state machine** mapped onto A2A's TaskState split (interruptible
 *    vs terminal). `rejected` is first-class and REQUIRES a reason (evidentiary).
 *  - **Append-only audit**: every transition is its own event row (who/when/
 *    from→to/note), never a silently mutated field — for compliance defensibility.
 *  - **Context transfer is a SCOPED BRIEFING, not the raw transcript** (the
 *    strongest 2026 consensus — full transcripts blow up tokens and bury signal):
 *    decisions, open questions, a single next action, artifact refs, confidence.
 *  - **Anti-loop**: a handoff carries a `depth`; chaining past `maxDepth` is
 *    refused (frameworks ship no built-in recursion limit — you must add one).
 *  - **SLA timer**: a handoff can expire (unbounded human waits deadlock runs);
 *    `expireDue` flips overdue `requested`/`accepted` handoffs to `timed_out`.
 *  - **Authorization by actor**: only the RECIPIENT accepts/rejects/starts/hands
 *    back; only the REQUESTER cancels (the host adds run-access checks on top).
 *
 * Ports & adapters (Phase 0–4 pattern): the {@link UnifiedHandoffManager} PORT +
 * an in-memory reference adapter live here; geneWeave provides a SQL adapter over
 * `session_handoffs` + `handoff_events`. Both pass {@link handoffManagerContract}.
 */

/** Which kind of baton-pass this is. */
export type HandoffScope = 'user_to_user' | 'agent_to_human' | 'agent_to_agent';

/**
 * Lifecycle states. Non-terminal: `requested`, `accepted`, `in_progress`,
 * `handed_back` (awaiting the original side to resume/close). Terminal:
 * `rejected`, `cancelled`, `completed`, `failed`, `timed_out`. Mirrors A2A's
 * interruptible-vs-terminal split.
 */
export type HandoffState =
  | 'requested' | 'accepted' | 'in_progress' | 'handed_back'
  | 'rejected' | 'cancelled' | 'completed' | 'failed' | 'timed_out';

const TERMINAL_STATES = new Set<HandoffState>(['rejected', 'cancelled', 'completed', 'failed', 'timed_out']);
export function isTerminalHandoffState(s: HandoffState): boolean { return TERMINAL_STATES.has(s); }

/** A participant in a handoff — a person, an agent, or a role queue. */
export interface HandoffActor {
  type: 'user' | 'agent' | 'role';
  id: string;
}

/**
 * The SCOPED context that travels with a handoff — a structured briefing, NOT
 * the raw transcript. Artifacts are referenced (by path/url), never duplicated.
 */
export interface HandoffBriefing {
  /** One-paragraph "here is where things stand". */
  summary: string;
  /** Key decisions made + their rationale. */
  decisions?: string[];
  /** What is still unresolved. */
  openQuestions?: string[];
  /** The single next action the recipient should take. */
  nextAction?: string;
  /** Referenced artifacts (by name + opaque ref), not inlined content. */
  artifacts?: Array<{ name: string; ref: string }>;
  /** Confidence 0–1 of the handing-off party. */
  confidence?: number;
}

export interface Handoff {
  id: string;
  /** The run/session being handed off — the spine that survives the whole chain (A2A `contextId`). */
  runId: string;
  tenantId: string;
  scope: HandoffScope;
  fromActor: HandoffActor;
  toActor: HandoffActor;
  state: HandoffState;
  /** Why the handoff was requested (the escalation reason). */
  reason: string;
  /** Scoped context handed FORWARD to the recipient. */
  briefing: HandoffBriefing | null;
  /** Why it was rejected (required on reject) / failed. */
  rejectionReason: string | null;
  /** Scoped context handed BACK when the recipient finishes. */
  handBackBriefing: HandoffBriefing | null;
  /** Anti-loop chain depth (a handoff spawned from another increments this). */
  depth: number;
  /** Optional parent handoff (for chained delegation + the depth count). */
  parentHandoffId: string | null;
  /** Cross-protocol task references (e.g. A2A `referenceTaskIds`) for agent scopes. */
  referenceTaskIds: string[];
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  /** SLA deadline — past this while still `requested`/`accepted` → `timed_out`. */
  expiresAt: number | null;
}

/** One append-only audit row: a single state transition. */
export interface HandoffEvent {
  id: string;
  handoffId: string;
  at: number;
  actorId: string;
  fromState: HandoffState | null;
  toState: HandoffState;
  note: string | null;
}

export interface RequestHandoffInput {
  id: string;
  runId: string;
  tenantId: string;
  scope: HandoffScope;
  fromActor: HandoffActor;
  toActor: HandoffActor;
  reason: string;
  briefing?: HandoffBriefing | null;
  parentHandoffId?: string | null;
  referenceTaskIds?: string[];
  /** Relative SLA — `expiresAt = now + ttlMs`. */
  ttlMs?: number;
  /** Anti-loop cap (default 5). */
  maxDepth?: number;
}

export interface UnifiedHandoffManager {
  /** Create a handoff in `requested` state (+ the first audit event). */
  request(input: RequestHandoffInput): Promise<Handoff>;
  /** Recipient accepts → `accepted`. */
  accept(id: string, byActorId: string, note?: string): Promise<Handoff>;
  /** Recipient declines → `rejected`. Reason is REQUIRED. */
  reject(id: string, byActorId: string, reason: string): Promise<Handoff>;
  /** Requester withdraws → `cancelled`. */
  cancel(id: string, byActorId: string, note?: string): Promise<Handoff>;
  /** Recipient takes over → `in_progress` (from `accepted`). */
  start(id: string, byActorId: string, note?: string): Promise<Handoff>;
  /** Recipient finishes + returns control → `handed_back` (carries a back-briefing). */
  handBack(id: string, byActorId: string, briefing?: HandoffBriefing | null, note?: string): Promise<Handoff>;
  /** Close out → `completed` (from `in_progress` or `handed_back`). */
  complete(id: string, byActorId: string, note?: string): Promise<Handoff>;
  /** Mark failed → `failed` (carries a reason). */
  fail(id: string, byActorId: string, reason: string): Promise<Handoff>;
  get(id: string): Promise<Handoff | null>;
  /** All handoffs on a run (newest first). */
  listForRun(runId: string): Promise<Handoff[]>;
  /** Handoffs whose RECIPIENT is this actor (their inbox). */
  listForActor(actorId: string): Promise<Handoff[]>;
  /** The append-only audit trail for a handoff (oldest first). */
  audit(id: string): Promise<HandoffEvent[]>;
  /** SLA sweep: flip overdue `requested`/`accepted` handoffs to `timed_out`; returns those changed. */
  expireDue(now: number): Promise<Handoff[]>;
}

/** Allowed transitions: current state → set of next states. */
const TRANSITIONS: Record<HandoffState, Set<HandoffState>> = {
  requested: new Set(['accepted', 'rejected', 'cancelled', 'timed_out']),
  accepted: new Set(['in_progress', 'cancelled', 'timed_out', 'failed']),
  in_progress: new Set(['handed_back', 'completed', 'failed']),
  handed_back: new Set(['completed', 'failed']),
  rejected: new Set(), cancelled: new Set(), completed: new Set(), failed: new Set(), timed_out: new Set(),
};

export function canTransition(from: HandoffState, to: HandoffState): boolean {
  return TRANSITIONS[from]?.has(to) ?? false;
}

// ─── In-memory reference adapter ────────────────────────────────────────────────

export interface InMemoryHandoffManagerOptions {
  now?: () => number;
  /** Generate audit-event ids deterministically in tests. */
  eventId?: () => string;
}

export function createInMemoryHandoffManager(opts: InMemoryHandoffManagerOptions = {}): UnifiedHandoffManager {
  const now = opts.now ?? (() => Date.now());
  let seq = 0;
  const eventId = opts.eventId ?? (() => `ev-${++seq}`);
  const handoffs = new Map<string, Handoff>();
  const events: HandoffEvent[] = [];

  function audit(handoffId: string, actorId: string, fromState: HandoffState | null, toState: HandoffState, note: string | null): void {
    events.push({ id: eventId(), handoffId, at: now(), actorId, fromState, toState, note });
  }

  /** Guarded transition: validate the move + the acting actor, persist + audit. */
  function transition(id: string, byActorId: string, to: HandoffState, who: 'from' | 'to', patch: Partial<Handoff> = {}, note?: string): Handoff {
    const h = handoffs.get(id);
    if (!h) throw new Error(`handoff '${id}' not found`);
    if (!canTransition(h.state, to)) throw new Error(`illegal transition ${h.state} → ${to}`);
    const requiredActor = who === 'from' ? h.fromActor.id : h.toActor.id;
    if (byActorId !== requiredActor) throw new Error(`forbidden: only the ${who === 'from' ? 'requester' : 'recipient'} may perform this transition`);
    const updated: Handoff = {
      ...h, ...patch, state: to, updatedAt: now(),
      resolvedAt: isTerminalHandoffState(to) ? now() : h.resolvedAt,
    };
    handoffs.set(id, updated);
    audit(id, byActorId, h.state, to, note ?? null);
    return updated;
  }

  return {
    async request(input) {
      const depth = (() => {
        if (!input.parentHandoffId) return 0;
        const parent = handoffs.get(input.parentHandoffId);
        return parent ? parent.depth + 1 : 0;
      })();
      const maxDepth = input.maxDepth ?? 5;
      if (depth > maxDepth) throw new Error(`handoff chain too deep (> ${maxDepth}) — refusing to avoid a handoff loop`);
      if (!input.reason?.trim()) throw new Error('a handoff requires a reason');
      const ts = now();
      const h: Handoff = {
        id: input.id, runId: input.runId, tenantId: input.tenantId, scope: input.scope,
        fromActor: input.fromActor, toActor: input.toActor, state: 'requested', reason: input.reason,
        briefing: input.briefing ?? null, rejectionReason: null, handBackBriefing: null,
        depth, parentHandoffId: input.parentHandoffId ?? null, referenceTaskIds: input.referenceTaskIds ?? [],
        createdAt: ts, updatedAt: ts, resolvedAt: null,
        expiresAt: input.ttlMs ? ts + input.ttlMs : null,
      };
      handoffs.set(h.id, h);
      audit(h.id, input.fromActor.id, null, 'requested', input.reason);
      return h;
    },
    async accept(id, byActorId, note) { return transition(id, byActorId, 'accepted', 'to', {}, note); },
    async reject(id, byActorId, reason) {
      if (!reason?.trim()) throw new Error('a rejection requires a reason');
      return transition(id, byActorId, 'rejected', 'to', { rejectionReason: reason }, reason);
    },
    async cancel(id, byActorId, note) { return transition(id, byActorId, 'cancelled', 'from', {}, note); },
    async start(id, byActorId, note) { return transition(id, byActorId, 'in_progress', 'to', {}, note); },
    async handBack(id, byActorId, briefing, note) { return transition(id, byActorId, 'handed_back', 'to', { handBackBriefing: briefing ?? null }, note); },
    async complete(id, byActorId, note) {
      // Either party may close out a handed_back/in_progress handoff.
      const h = handoffs.get(id);
      if (!h) throw new Error(`handoff '${id}' not found`);
      if (byActorId !== h.fromActor.id && byActorId !== h.toActor.id) throw new Error('forbidden: only a participant may complete a handoff');
      if (!canTransition(h.state, 'completed')) throw new Error(`illegal transition ${h.state} → completed`);
      const updated: Handoff = { ...h, state: 'completed', updatedAt: now(), resolvedAt: now() };
      handoffs.set(id, updated);
      audit(id, byActorId, h.state, 'completed', note ?? null);
      return updated;
    },
    async fail(id, byActorId, reason) {
      const h = handoffs.get(id);
      if (!h) throw new Error(`handoff '${id}' not found`);
      if (byActorId !== h.fromActor.id && byActorId !== h.toActor.id) throw new Error('forbidden: only a participant may fail a handoff');
      if (!canTransition(h.state, 'failed')) throw new Error(`illegal transition ${h.state} → failed`);
      const updated: Handoff = { ...h, state: 'failed', rejectionReason: reason, updatedAt: now(), resolvedAt: now() };
      handoffs.set(id, updated);
      audit(id, byActorId, h.state, 'failed', reason);
      return updated;
    },
    async get(id) { return handoffs.get(id) ?? null; },
    async listForRun(runId) {
      return [...handoffs.values()].filter((h) => h.runId === runId).sort((a, b) => b.createdAt - a.createdAt);
    },
    async listForActor(actorId) {
      return [...handoffs.values()].filter((h) => h.toActor.id === actorId).sort((a, b) => b.createdAt - a.createdAt);
    },
    async audit(id) {
      return events.filter((e) => e.handoffId === id).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    },
    async expireDue(nowMs) {
      const changed: Handoff[] = [];
      for (const h of handoffs.values()) {
        if ((h.state === 'requested' || h.state === 'accepted') && h.expiresAt !== null && h.expiresAt <= nowMs) {
          const updated: Handoff = { ...h, state: 'timed_out', updatedAt: nowMs, resolvedAt: nowMs };
          handoffs.set(h.id, updated);
          audit(h.id, 'system', h.state, 'timed_out', 'SLA expired');
          changed.push(updated);
        }
      }
      return changed;
    },
  };
}
