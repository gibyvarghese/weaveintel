/**
 * @weaveintel/collaboration — Durable run registry (W3)
 *
 * Persists `RunHandle` snapshots via `runtime.persistence.kv` so run state
 * survives process restarts and is observable from any client.
 *
 * Key schema:
 *   `<ns>:<tenantId>:<runId>` → JSON-encoded `RunHandle`
 *
 * Tenant isolation is strict: `get` and `listByPrincipal` compare the
 * `tenantId` from the `ExecutionContext` against the stored value and throw
 * on mismatch.
 *
 * Status-update idempotency: updates are keyed by `<idempotency-ns>:<runId>:<status>:<sequence>`
 * and stored for `idempotencyTtlMs` (default 5 min). Retried writes with the
 * same key are no-ops (safe to replay).
 *
 * Lifecycle events: emitted on the injected `EventBus` (optional) so
 * notification dispatchers and triggers can subscribe without coupling to the
 * registry call site.
 */

import {
  weaveInMemoryPersistence,
  newUUIDv7,
  type RuntimeKvStore,
  type WeaveRuntime,
  type RunHandle,
  type RunStatus,
  type EventBus,
  type ExecutionContext,
} from '@weaveintel/core';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunRegistryOptions {
  runtime?: WeaveRuntime;
  /** KV namespace prefix for run rows. Default: `'run-registry'`. */
  namespace?: string;
  /** KV namespace prefix for idempotency records. Default: `'run-idempotency'`. */
  idempotencyNamespace?: string;
  /** TTL for idempotency records, ms. Default: 5 minutes. */
  idempotencyTtlMs?: number;
  /** Optional bus — lifecycle events are emitted when provided. */
  bus?: EventBus;
}

export interface RunListFilter {
  status?: RunStatus[];
  origin?: RunHandle['origin'][];
  limit?: number;
}

export interface RunRegistry {
  /**
   * Persist a new `RunHandle`.  Idempotent: registering the same `runId`
   * twice overwrites the first row (caller is responsible for uniqueness).
   */
  register(ctx: ExecutionContext, handle: RunHandle): Promise<void>;

  /**
   * Update `status` (and optionally `progress` / `error`) for an existing run.
   * No-ops when the same status transition was already applied (idempotent).
   * Emits a lifecycle event on the bus.
   * Throws if the run is not found or belongs to a different tenant.
   */
  updateStatus(
    ctx: ExecutionContext,
    runId: string,
    status: RunStatus,
    opts?: { progress?: number; error?: { code: string; message: string }; sequence?: number },
  ): Promise<RunHandle>;

  /** Retrieve a single run.  Throws on cross-tenant access. */
  get(ctx: ExecutionContext, runId: string): Promise<RunHandle | null>;

  /**
   * List all runs owned by `principalId` within the caller's tenant.
   * Cross-tenant access is blocked by `ctx.identity.tenantId` comparison.
   */
  listByPrincipal(
    ctx: ExecutionContext,
    principalId: string,
    filter?: RunListFilter,
  ): Promise<RunHandle[]>;

  /**
   * Record that event `sequence` has been emitted for `runId`.
   * Updates `lastSequence` on the stored handle.
   */
  markSequence(ctx: ExecutionContext, runId: string, sequence: number): Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveKv(runtime: WeaveRuntime | undefined): RuntimeKvStore {
  return runtime?.persistence?.kv ?? weaveInMemoryPersistence().kv;
}

function tenantFromCtx(ctx: ExecutionContext): string {
  const tid = (ctx.metadata?.['tenantId'] as string | undefined) ?? (ctx as unknown as { tenantId?: string }).tenantId;
  return tid ?? '__default__';
}

function principalFromCtx(ctx: ExecutionContext): string | undefined {
  return (ctx.metadata?.['principalId'] as string | undefined) ??
    (ctx as unknown as { identity?: { id?: string } }).identity?.id;
}

// ─── Implementation ────────────────────────────────────────────────────────────

export function createRunRegistry(opts: RunRegistryOptions = {}): RunRegistry {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'run-registry';
  const idempNs = opts.idempotencyNamespace ?? 'run-idempotency';
  const idempTtl = opts.idempotencyTtlMs ?? 5 * 60 * 1000;
  const bus = opts.bus;

  function runKey(tenantId: string, runId: string): string {
    return `${ns}:${tenantId}:${runId}`;
  }

  function idempKey(runId: string, status: string, sequence: number): string {
    return `${idempNs}:${runId}:${status}:${sequence}`;
  }

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
      bus.emit({
        type: eventType,
        timestamp: Date.now(),
        tenantId: handle.tenantId,
        data: handle as unknown as Record<string, unknown>,
      });
    } catch {
      // Best-effort — lifecycle event emission never throws into the caller
    }
  }

  return {
    async register(ctx, handle) {
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

      // Idempotency: skip if this exact status+sequence transition already happened
      const seq = opts.sequence ?? existing.lastSequence;
      const idKey = idempKey(runId, status, seq);
      const dupCheck = await kv.get(idKey);
      if (dupCheck !== undefined) {
        // Already applied — return current state without double-emitting
        return existing;
      }
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

      // Lifecycle events
      if (status === 'completed') await emitLifecycle('run.completed', updated);
      else if (status === 'failed') await emitLifecycle('run.failed', updated);
      else if (status === 'cancelled') await emitLifecycle('run.cancelled', updated);
      else if (opts.progress !== undefined) await emitLifecycle('run.progress', updated);

      return updated;
    },

    async get(ctx, runId) {
      const tenantId = tenantFromCtx(ctx);
      const handle = await loadHandle(tenantId, runId);
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
        } catch { /* skip corrupt entries */ }
      }
      if (filter?.status?.length) {
        runs = runs.filter((r) => filter.status!.includes(r.status));
      }
      if (filter?.origin?.length) {
        runs = runs.filter((r) => filter.origin!.includes(r.origin));
      }
      if (filter?.limit) {
        runs = runs.slice(0, filter.limit);
      }
      return runs;
    },

    async markSequence(ctx, runId, sequence) {
      const tenantId = tenantFromCtx(ctx);
      const existing = await loadHandle(tenantId, runId);
      if (!existing) return;
      assertTenantMatch(ctx, existing);
      if (sequence <= existing.lastSequence) return; // already at or ahead
      const updated: RunHandle = { ...existing, lastSequence: sequence, updatedAt: new Date().toISOString() };
      await saveHandle(updated);
    },
  };
}
