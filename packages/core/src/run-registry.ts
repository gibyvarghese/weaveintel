/**
 * Run registry — the canonical durable run-handle store contract.
 *
 * Collaboration Phase 0: relocated from `@weaveintel/collaboration` into
 * `@weaveintel/core` (the §5b verdict). A "run registry" tracks the *current
 * state* of every run — its status, owner, progress, last-seen event sequence —
 * so that state survives a process restart and is queryable from any client.
 * Its vocabulary (`RunHandle`, `RunStatus`) already lives in core, and geneWeave
 * already owns a SQL implementation, so the PORT + a reference KV adapter belong
 * here; geneWeave's `user_runs` table is just another adapter behind it.
 *
 * --- For someone new to this ---
 * If the {@link RunJournal} is the *list of everything that happened*, the
 * registry is the *one-line summary*: "run X is running, owned by user Y, 41
 * events so far." A "/runs" list page reads the registry; a live stream reads
 * the journal. Keeping them separate keeps each query fast.
 *
 * Tenant isolation is strict (the §1 bug fix): a run is keyed by
 * `<ns>:<tenantId>:<runId>`, and `register` now asserts the handle's tenant
 * matches the calling context (previously it trusted the handle blindly).
 *
 * Two adapters conform to {@link RunRegistry}: {@link createKvRunRegistry} (here)
 * and geneWeave's `SqlRunRegistry`, both validated by {@link runRegistryContract}.
 */
import { weaveInMemoryPersistence } from './runtime.js';
import type { RuntimeKvStore, WeaveRuntime } from './runtime.js';
import type { RunHandle, RunStatus } from './runs.js';
import type { EventBus } from './events.js';
import type { ExecutionContext } from './context.js';

// ─── Port ──────────────────────────────────────────────────────────────────────

export interface RunListFilter {
  status?: RunStatus[];
  origin?: RunHandle['origin'][];
  limit?: number;
}

export interface RunRegistry {
  /**
   * Persist a new `RunHandle`. Asserts the handle's `tenantId` matches the
   * calling context (no cross-tenant writes). Re-registering the same `runId`
   * overwrites — callers own run-id uniqueness.
   */
  register(ctx: ExecutionContext, handle: RunHandle): Promise<void>;
  /**
   * Update status (and optionally progress/error) for an existing run.
   * Idempotent per `(status, sequence)`; emits a lifecycle event on the bus.
   * Throws if not found or cross-tenant.
   */
  updateStatus(
    ctx: ExecutionContext,
    runId: string,
    status: RunStatus,
    opts?: { progress?: number; error?: { code: string; message: string }; sequence?: number },
  ): Promise<RunHandle>;
  /** Retrieve one run (tenant-scoped). Returns null if not found. */
  get(ctx: ExecutionContext, runId: string): Promise<RunHandle | null>;
  /** List runs owned by `principalId` in the caller's tenant, newest first. */
  listByPrincipal(ctx: ExecutionContext, principalId: string, filter?: RunListFilter): Promise<RunHandle[]>;
  /** Advance the run's `lastSequence` watermark (the resume cursor). */
  markSequence(ctx: ExecutionContext, runId: string, sequence: number): Promise<void>;
}

export interface KvRunRegistryOptions {
  runtime?: WeaveRuntime;
  /** KV namespace prefix for run rows. Default `'run-registry'`. */
  namespace?: string;
  /** KV namespace prefix for idempotency records. Default `'run-idempotency'`. */
  idempotencyNamespace?: string;
  /** TTL for idempotency records, ms. Default 5 minutes. */
  idempotencyTtlMs?: number;
  /** Optional bus — lifecycle events are emitted when provided. */
  bus?: EventBus;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveKv(runtime: WeaveRuntime | undefined): RuntimeKvStore {
  return runtime?.persistence?.kv ?? weaveInMemoryPersistence().kv;
}

function tenantFromCtx(ctx: ExecutionContext): string {
  const tid = (ctx.metadata?.['tenantId'] as string | undefined) ?? (ctx as unknown as { tenantId?: string }).tenantId;
  return tid ?? '__default__';
}

// ─── KV reference adapter ──────────────────────────────────────────────────────

export function createKvRunRegistry(opts: KvRunRegistryOptions = {}): RunRegistry {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'run-registry';
  const idempNs = opts.idempotencyNamespace ?? 'run-idempotency';
  const idempTtl = opts.idempotencyTtlMs ?? 5 * 60 * 1000;
  const bus = opts.bus;

  const runKey = (tenantId: string, runId: string) => `${ns}:${tenantId}:${runId}`;
  const idempKey = (runId: string, status: string, sequence: number) => `${idempNs}:${runId}:${status}:${sequence}`;

  async function loadHandle(tenantId: string, runId: string): Promise<RunHandle | null> {
    const raw = await kv.get(runKey(tenantId, runId));
    if (!raw) return null;
    try { return JSON.parse(raw) as RunHandle; } catch { return null; }
  }
  async function saveHandle(handle: RunHandle): Promise<void> {
    await kv.set(runKey(handle.tenantId, handle.runId), JSON.stringify(handle));
  }
  function assertTenantMatch(ctx: ExecutionContext, handle: RunHandle): void {
    const ctxTenant = tenantFromCtx(ctx);
    if (ctxTenant !== handle.tenantId) {
      throw new Error(
        `Cross-tenant access denied: context tenant '${ctxTenant}' does not match run tenant '${handle.tenantId}'`,
      );
    }
  }
  async function emitLifecycle(eventType: string, handle: RunHandle): Promise<void> {
    if (!bus) return;
    try {
      bus.emit({ type: eventType, timestamp: Date.now(), tenantId: handle.tenantId, data: handle as unknown as Record<string, unknown> });
    } catch { /* best-effort — never throws into the caller */ }
  }

  return {
    async register(ctx, handle) {
      // §1 bug fix: assert the handle's tenant matches the caller before writing.
      assertTenantMatch(ctx, handle);
      await saveHandle(handle);
      if (handle.status === 'running' || handle.status === 'pending') {
        await emitLifecycle('run.started', handle);
      }
    },

    async updateStatus(ctx, runId, status, opts = {}) {
      const tenantId = tenantFromCtx(ctx);
      const existing = await loadHandle(tenantId, runId);
      if (!existing) throw new Error(`Run '${runId}' not found`);
      assertTenantMatch(ctx, existing);

      const seq = opts.sequence ?? existing.lastSequence;
      const idKey = idempKey(runId, status, seq);
      if ((await kv.get(idKey)) !== undefined) return existing; // already applied
      await kv.set(idKey, '1', { ttlMs: idempTtl });

      const now = new Date().toISOString();
      const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
      const updated: RunHandle = {
        ...existing,
        status,
        updatedAt: now,
        ...(opts.progress !== undefined ? { progress: opts.progress } : {}),
        ...(isTerminal ? { completedAt: now } : {}),
        ...(opts.error !== undefined ? { error: opts.error } : {}),
        lastSequence: Math.max(existing.lastSequence, seq),
      };
      await saveHandle(updated);

      if (status === 'completed') await emitLifecycle('run.completed', updated);
      else if (status === 'failed') await emitLifecycle('run.failed', updated);
      else if (status === 'cancelled') await emitLifecycle('run.cancelled', updated);
      else if (opts.progress !== undefined) await emitLifecycle('run.progress', updated);
      return updated;
    },

    async get(ctx, runId) {
      const handle = await loadHandle(tenantFromCtx(ctx), runId);
      if (!handle) return null;
      assertTenantMatch(ctx, handle);
      return handle;
    },

    async listByPrincipal(ctx, principalId, filter) {
      const tenantId = tenantFromCtx(ctx);
      const entries = await kv.list(`${ns}:${tenantId}:`);
      let runs: RunHandle[] = [];
      for (const e of entries) {
        try {
          const h = JSON.parse(e.value) as RunHandle;
          if (h.principalId === principalId) runs.push(h);
        } catch { /* skip corrupt */ }
      }
      if (filter?.status?.length) runs = runs.filter((r) => filter.status!.includes(r.status));
      if (filter?.origin?.length) runs = runs.filter((r) => filter.origin!.includes(r.origin));
      // §1 fix: deterministic newest-first ordering, THEN limit.
      runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      if (filter?.limit) runs = runs.slice(0, filter.limit);
      return runs;
    },

    async markSequence(ctx, runId, sequence) {
      const tenantId = tenantFromCtx(ctx);
      const existing = await loadHandle(tenantId, runId);
      if (!existing) return;
      assertTenantMatch(ctx, existing);
      if (sequence <= existing.lastSequence) return;
      await saveHandle({ ...existing, lastSequence: sequence, updatedAt: new Date().toISOString() });
    },
  };
}
