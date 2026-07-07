// SPDX-License-Identifier: MIT
/**
 * The workflow storage stores, each implemented ONCE against Drizzle and reused for both Postgres and
 * SQLite (Phase 4). No raw SQL, so the classic per-dialect drift bugs (`$1` vs `?`, hand-rolled JSON,
 * `NOW()` vs `CURRENT_TIMESTAMP`) simply can't happen. The thin `weavePostgres*` / `weaveSqlite*`
 * factories wrap these with the right Drizzle handle + exec adapter (see `drizzle-exec.ts`).
 *
 * Tables come from `drizzle-workflow-schema.ts`; the shared logic is typed against the Postgres table
 * (the reference), and each SQLite factory passes its handle with one contained cast.
 */
import { and, asc, count, desc, eq, gt, inArray, like, lt, lte } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
  WorkflowDefinition, WorkflowRun, SleepRecord, WorkflowAuditEvent, WorkflowAuditLog,
} from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import type { StepIdempotencyStore } from './idempotency-store.js';
import type { PayloadStore } from './payload-store.js';
import type { StepLockStore } from './step-lock-store.js';
import type { WorkflowDefinitionStore } from './definition-store.js';
import type { WorkflowRunRepository, RunFilterOpts } from './run-repository.js';
import type { WorkflowRunQueue, RunQueueEntry } from './run-queue.js';
import type { WorkflowRateLimiter } from './rate-limiter.js';
import { type DrizzleExec, monotonicIso } from './drizzle-exec.js';
import type {
  PgIdempotency, PgPayloads, PgStepLocks, PgDefinitions, PgRuns, PgSleeps, PgRunQueue, PgAudit, PgRateLimits,
} from './drizzle-workflow-schema.js';

const nowIso = () => new Date().toISOString();
const num = (v: unknown): number => Number(v);

// ─── Idempotency ────────────────────────────────────────────────────────────────
export function createDrizzleIdempotencyStore(deps: { db: NodePgDatabase; table: PgIdempotency; exec: DrizzleExec }): StepIdempotencyStore {
  const { db, table, exec } = deps;
  return {
    async get(key) {
      const rows = await exec.all<{ outputJson: unknown }>(db.select({ outputJson: table.outputJson }).from(table).where(eq(table.key, key)).limit(1));
      return rows.length ? rows[0]!.outputJson : undefined;
    },
    async set(key, output) {
      await exec.run(db.insert(table).values({ key, outputJson: output ?? null, createdAt: nowIso() })
        .onConflictDoUpdate({ target: table.key, set: { outputJson: output ?? null } }));
    },
    async delete(key) { await exec.run(db.delete(table).where(eq(table.key, key))); },
    async clearPrefix(prefix) { await exec.run(db.delete(table).where(like(table.key, `${prefix}%`))); },
  };
}

// ─── Payload ────────────────────────────────────────────────────────────────────
export function createDrizzlePayloadStore(deps: { db: NodePgDatabase; table: PgPayloads; exec: DrizzleExec }): PayloadStore {
  const { db, table, exec } = deps;
  const runIdOf = (key: string) => { const i = key.indexOf(':'); return i === -1 ? key : key.slice(0, i); };
  return {
    async put(key, data) {
      await exec.run(db.insert(table).values({ key, runId: runIdOf(key), dataJson: data ?? null, createdAt: nowIso() })
        .onConflictDoUpdate({ target: table.key, set: { dataJson: data ?? null } }));
    },
    async get(key) {
      const rows = await exec.all<{ dataJson: unknown }>(db.select({ dataJson: table.dataJson }).from(table).where(eq(table.key, key)).limit(1));
      return rows.length ? rows[0]!.dataJson : undefined;
    },
    async delete(key) { await exec.run(db.delete(table).where(eq(table.key, key))); },
    async deleteRun(runId) { await exec.run(db.delete(table).where(eq(table.runId, runId))); },
  };
}

// ─── Step lock ──────────────────────────────────────────────────────────────────
export function createDrizzleStepLockStore(deps: { db: NodePgDatabase; table: PgStepLocks; exec: DrizzleExec }): StepLockStore {
  const { db, table, exec } = deps;
  return {
    async lock(runId, stepId) {
      await exec.run(db.insert(table).values({ runId, stepId, state: 'locked', lockedAt: nowIso() }).onConflictDoNothing());
    },
    async markDone(runId, stepId, output) {
      const ts = nowIso();
      await exec.run(db.insert(table).values({ runId, stepId, state: 'done', lockedAt: ts, doneAt: ts, outputJson: output ?? null })
        .onConflictDoUpdate({ target: [table.runId, table.stepId], set: { state: 'done', doneAt: ts, outputJson: output ?? null } }));
    },
    async isDone(runId, stepId) {
      const rows = await exec.all<{ state: string; outputJson: unknown }>(
        db.select({ state: table.state, outputJson: table.outputJson }).from(table).where(and(eq(table.runId, runId), eq(table.stepId, stepId))).limit(1),
      );
      const row = rows[0];
      if (!row || row.state !== 'done') return { done: false };
      return row.outputJson == null ? { done: true } : { done: true, output: row.outputJson };
    },
    async isLocked(runId, stepId) {
      const rows = await exec.all(db.select({ runId: table.runId }).from(table).where(and(eq(table.runId, runId), eq(table.stepId, stepId))).limit(1));
      return rows.length > 0;
    },
    async clear(runId) { await exec.run(db.delete(table).where(eq(table.runId, runId))); },
  };
}

// ─── Workflow definitions ─────────────────────────────────────────────────────────
type DefWithTimes = WorkflowDefinition & { createdAt?: string; updatedAt?: string };
export function createDrizzleDefinitionStore(deps: { db: NodePgDatabase; table: PgDefinitions; exec: DrizzleExec; now?: () => string }): WorkflowDefinitionStore {
  const { db, table, exec } = deps;
  const now = deps.now ?? monotonicIso();
  return {
    async list() {
      const rows = await exec.all<{ payloadJson: WorkflowDefinition }>(db.select({ payloadJson: table.payloadJson }).from(table).orderBy(desc(table.updatedAt), desc(table.id)));
      return rows.map((r) => r.payloadJson);
    },
    async get(idOrKey) {
      const byId = await exec.all<{ payloadJson: WorkflowDefinition }>(db.select({ payloadJson: table.payloadJson }).from(table).where(eq(table.id, idOrKey)).limit(1));
      if (byId.length) return byId[0]!.payloadJson;
      const byName = await exec.all<{ payloadJson: WorkflowDefinition }>(db.select({ payloadJson: table.payloadJson }).from(table).where(eq(table.name, idOrKey)).limit(1));
      return byName.length ? byName[0]!.payloadJson : null;
    },
    async save(def) {
      const ts = now();
      const d = def as DefWithTimes;
      const saved: DefWithTimes = { ...d, createdAt: d.createdAt ?? ts, updatedAt: ts };
      await exec.run(db.insert(table).values({ id: saved.id, name: saved.name, payloadJson: saved, createdAt: saved.createdAt!, updatedAt: ts })
        .onConflictDoUpdate({ target: table.id, set: { name: saved.name, payloadJson: saved, updatedAt: ts } }));
      return saved;
    },
    async delete(id) { await exec.run(db.delete(table).where(eq(table.id, id))); },
  };
}

// ─── Workflow runs ────────────────────────────────────────────────────────────────
type RunScalars = WorkflowRun & { parentRunId?: string; tenantId?: string };
export function createDrizzleRunRepository(deps: { db: NodePgDatabase; table: PgRuns; exec: DrizzleExec }): WorkflowRunRepository {
  const { db, table, exec } = deps;
  const cols = { payloadJson: table.payloadJson };
  const map = (rows: { payloadJson: WorkflowRun }[]) => rows.map((r) => r.payloadJson);
  return {
    async save(run) {
      const r = run as RunScalars;
      await exec.run(db.insert(table).values({
        id: r.id, workflowId: r.workflowId, parentRunId: r.parentRunId ?? null, status: r.status,
        tenantId: r.tenantId ?? null, startedAt: r.startedAt, payloadJson: run,
      }).onConflictDoUpdate({
        target: table.id,
        set: { workflowId: r.workflowId, parentRunId: r.parentRunId ?? null, status: r.status, tenantId: r.tenantId ?? null, startedAt: r.startedAt, payloadJson: run },
      }));
    },
    async get(runId) {
      const rows = await exec.all<{ payloadJson: WorkflowRun }>(db.select(cols).from(table).where(eq(table.id, runId)).limit(1));
      return rows.length ? rows[0]!.payloadJson : null;
    },
    async list(workflowId) {
      const base = db.select(cols).from(table);
      const q = workflowId ? base.where(eq(table.workflowId, workflowId)) : base;
      return map(await exec.all<{ payloadJson: WorkflowRun }>(q.orderBy(desc(table.startedAt), desc(table.id))));
    },
    async listByParent(parentRunId) {
      return map(await exec.all<{ payloadJson: WorkflowRun }>(db.select(cols).from(table).where(eq(table.parentRunId, parentRunId)).orderBy(desc(table.startedAt), desc(table.id))));
    },
    async listFiltered(opts: RunFilterOpts) {
      const conds = [
        opts.workflowId ? eq(table.workflowId, opts.workflowId) : undefined,
        opts.status ? eq(table.status, opts.status) : undefined,
        opts.tenantId ? eq(table.tenantId, opts.tenantId) : undefined,
        opts.before ? lt(table.startedAt, opts.before) : undefined,
        opts.after ? gt(table.startedAt, opts.after) : undefined,
      ].filter(Boolean);
      const base = db.select(cols).from(table).where(conds.length ? and(...conds) : undefined).orderBy(desc(table.startedAt), desc(table.id));
      const q = opts.limit != null ? base.limit(opts.limit) : base;
      return map(await exec.all<{ payloadJson: WorkflowRun }>(q));
    },
    async countActive(workflowId) {
      const rows = await exec.all<{ c: number }>(db.select({ c: count() }).from(table).where(and(eq(table.workflowId, workflowId), inArray(table.status, ['running', 'paused']))));
      return num(rows[0]?.c ?? 0);
    },
    async delete(runId) { await exec.run(db.delete(table).where(eq(table.id, runId))); },
  };
}

// ─── Durable sleeps ──────────────────────────────────────────────────────────────
export function createDrizzleSleepStore(deps: { db: NodePgDatabase; table: PgSleeps; exec: DrizzleExec }): import('@weaveintel/core').DurableSleepStore {
  const { db, table, exec } = deps;
  const toRecord = (r: { runId: string; wakeAt: number; createdAt: string }): SleepRecord => ({ runId: r.runId, wakeAt: num(r.wakeAt), createdAt: r.createdAt });
  return {
    async schedule(runId, wakeAt) {
      await exec.run(db.insert(table).values({ runId, wakeAt, createdAt: nowIso() }).onConflictDoUpdate({ target: table.runId, set: { wakeAt } }));
    },
    async cancel(runId) { await exec.run(db.delete(table).where(eq(table.runId, runId))); },
    async getDue(now = Date.now()) {
      const rows = await exec.all<{ runId: string; wakeAt: number; createdAt: string }>(db.select().from(table).where(lte(table.wakeAt, now)).orderBy(asc(table.wakeAt), asc(table.runId)));
      return rows.map(toRecord);
    },
    async list() {
      const rows = await exec.all<{ runId: string; wakeAt: number; createdAt: string }>(db.select().from(table).orderBy(asc(table.wakeAt), asc(table.runId)));
      return rows.map(toRecord);
    },
  };
}

// ─── Run queue ───────────────────────────────────────────────────────────────────
interface RunQueueRow { id: string; runId: string; workflowId: string; inputJson: Record<string, unknown>; priority: number; queuedAt: string; optsJson: RunQueueEntry['opts'] }
const runQueueOrder = (table: PgRunQueue) => [desc(table.priority), asc(table.queuedAt), asc(table.id)] as const;
const runQueueRowToEntry = (r: RunQueueRow): RunQueueEntry =>
  ({ id: r.id, runId: r.runId, workflowId: r.workflowId, input: r.inputJson, priority: num(r.priority), queuedAt: r.queuedAt, opts: r.optsJson });

/**
 * Postgres dequeue: pick the next entry with `FOR UPDATE SKIP LOCKED` inside a transaction — the
 * idiomatic, race-free Postgres queue pop, so many workers can drain the queue in parallel without ever
 * taking the same entry. (SQLite has a single writer, so it uses the simple select-then-delete default.)
 */
export function createPgRunQueueDequeue(db: NodePgDatabase, table: PgRunQueue): (workflowId: string) => Promise<RunQueueEntry | null> {
  return (workflowId) => db.transaction(async (tx) => {
    const rows = await tx.select().from(table).where(eq(table.workflowId, workflowId)).orderBy(...runQueueOrder(table)).limit(1).for('update', { skipLocked: true });
    if (!rows.length) return null;
    const row = rows[0] as unknown as RunQueueRow;
    await tx.delete(table).where(eq(table.id, row.id));
    return runQueueRowToEntry(row);
  });
}

export function createDrizzleRunQueue(deps: { db: NodePgDatabase; table: PgRunQueue; exec: DrizzleExec; dequeue?: (workflowId: string) => Promise<RunQueueEntry | null> }): WorkflowRunQueue {
  const { db, table, exec } = deps;
  const order = runQueueOrder(table);
  // FIFO tiebreak within a priority must be deterministic. A plain wall-clock `queuedAt`
  // ties when two entries are enqueued in the same millisecond, which then falls through to
  // `asc(id)` — but a UUIDv7 id is NOT monotonic within a millisecond (its low bits are random),
  // so same-ms entries could dequeue out of insertion order. A strictly-increasing clock makes
  // `queuedAt` itself the total order, so the id tiebreak never decides FIFO.
  const queuedAtClock = monotonicIso();
  // Default (SQLite / single-writer): select the top entry then delete it by id.
  const defaultDequeue = async (workflowId: string): Promise<RunQueueEntry | null> => {
    const rows = await exec.all<RunQueueRow>(db.select().from(table).where(eq(table.workflowId, workflowId)).orderBy(...order).limit(1));
    if (!rows.length) return null;
    await exec.run(db.delete(table).where(eq(table.id, rows[0]!.id)));
    return runQueueRowToEntry(rows[0]!);
  };
  return {
    async enqueue(entry) {
      const full: RunQueueEntry = { ...entry, id: newUUIDv7(), queuedAt: queuedAtClock() };
      await exec.run(db.insert(table).values({ id: full.id, runId: full.runId, workflowId: full.workflowId, inputJson: full.input, priority: full.priority, queuedAt: full.queuedAt, optsJson: full.opts }));
      return full;
    },
    dequeue: deps.dequeue ?? defaultDequeue,
    async remove(entryId) { await exec.run(db.delete(table).where(eq(table.id, entryId))); },
    async size() {
      const rows = await exec.all<{ c: number }>(db.select({ c: count() }).from(table));
      return num(rows[0]?.c ?? 0);
    },
    async sizeFor(workflowId) {
      const rows = await exec.all<{ c: number }>(db.select({ c: count() }).from(table).where(eq(table.workflowId, workflowId)));
      return num(rows[0]?.c ?? 0);
    },
    async listFor(workflowId) {
      const rows = await exec.all<RunQueueRow>(db.select().from(table).where(eq(table.workflowId, workflowId)).orderBy(...order));
      return rows.map(runQueueRowToEntry);
    },
    async listAll() {
      const rows = await exec.all<RunQueueRow>(db.select().from(table).orderBy(...order));
      return rows.map(runQueueRowToEntry);
    },
  };
}

// ─── Audit log ───────────────────────────────────────────────────────────────────
export function createDrizzleAuditLog(deps: { db: NodePgDatabase; table: PgAudit; exec: DrizzleExec }): WorkflowAuditLog {
  const { db, table, exec } = deps;
  const toEvent = (r: { id: string; runId: string; workflowId: string; type: string; timestamp: string; payloadJson: Record<string, unknown> }): WorkflowAuditEvent =>
    ({ id: r.id, runId: r.runId, workflowId: r.workflowId, type: r.type, timestamp: r.timestamp, ...r.payloadJson });
  return {
    async append(event) {
      const full = { ...event, id: newUUIDv7() };
      const { id, runId, workflowId, type, timestamp, ...payload } = full;
      await exec.run(db.insert(table).values({ id, runId, workflowId, type, timestamp, payloadJson: payload }));
    },
    async list(runId) {
      const rows = await exec.all<Parameters<typeof toEvent>[0]>(db.select().from(table).where(eq(table.runId, runId)).orderBy(asc(table.timestamp), asc(table.id)));
      return rows.map(toEvent);
    },
    async listAll(opts) {
      const base = db.select().from(table);
      const filtered = opts?.workflowId ? base.where(eq(table.workflowId, opts.workflowId)) : base;
      if (opts?.limit != null) {
        // "last N" — take the newest N, then present them oldest → newest.
        const rows = await exec.all<Parameters<typeof toEvent>[0]>(filtered.orderBy(desc(table.timestamp), desc(table.id)).limit(opts.limit));
        return rows.map(toEvent).reverse();
      }
      const rows = await exec.all<Parameters<typeof toEvent>[0]>(filtered.orderBy(asc(table.timestamp), asc(table.id)));
      return rows.map(toEvent);
    },
  };
}

// ─── Rate limiter (token bucket) ──────────────────────────────────────────────────
export function createDrizzleRateLimiter(deps: { db: NodePgDatabase; table: PgRateLimits; exec: DrizzleExec }): WorkflowRateLimiter {
  const { db, table, exec } = deps;
  const read = async (workflowId: string): Promise<{ tokens: number; lastRefillMs: number } | undefined> => {
    const rows = await exec.all<{ tokens: number; lastRefillMs: number }>(db.select({ tokens: table.tokens, lastRefillMs: table.lastRefillMs }).from(table).where(eq(table.workflowId, workflowId)).limit(1));
    return rows[0] ? { tokens: num(rows[0].tokens), lastRefillMs: num(rows[0].lastRefillMs) } : undefined;
  };
  const refilled = (row: { tokens: number; lastRefillMs: number } | undefined, max: number, now: number): number => {
    if (!row) return max;
    const elapsedMin = (now - row.lastRefillMs) / 60_000;
    return Math.min(max, row.tokens + elapsedMin * max);
  };
  const upsert = async (workflowId: string, tokens: number, now: number) => {
    await exec.run(db.insert(table).values({ workflowId, tokens, lastRefillMs: now }).onConflictDoUpdate({ target: table.workflowId, set: { tokens, lastRefillMs: now } }));
  };
  return {
    async allow(workflowId, maxRunsPerMinute) {
      const now = Date.now();
      let tokens = refilled(await read(workflowId), maxRunsPerMinute, now);
      const ok = tokens >= 1;
      if (ok) tokens -= 1;
      await upsert(workflowId, tokens, now);
      return ok;
    },
    async remaining(workflowId, maxRunsPerMinute) {
      return Math.floor(refilled(await read(workflowId), maxRunsPerMinute, Date.now()));
    },
    async reset(workflowId) { await exec.run(db.delete(table).where(eq(table.workflowId, workflowId))); },
  };
}
