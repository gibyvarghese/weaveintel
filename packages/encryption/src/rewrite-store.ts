/**
 * @weaveintel/encryption — RewriteJobStore.
 *
 * Persistence contract for tenant-scoped rewrite jobs. A rewrite job
 * tracks the background re-encryption of one (table, column) for one
 * tenant after a DEK rotation: walking sentinel rows whose epoch is
 * below the current `to_epoch` and re-encrypting them under the active
 * DEK so old DEKs eventually become safe to revoke.
 *
 * Hosts wire `RewriteJobStore` over their preferred persistence
 * (SQLite / Postgres / Redis / in-memory). The package never imports
 * a database; it composes the store with `weaveRewriteScheduler`.
 */

export type RewriteJobStatus = 'pending' | 'running' | 'complete' | 'failed';

export interface RewriteJobRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly tableName: string;
  readonly columnName: string;
  readonly fromEpoch: number;
  readonly toEpoch: number;
  readonly lastRowId: string | null;
  readonly rowsRewritten: number;
  readonly status: RewriteJobStatus;
  readonly errorMessage?: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

export interface RewriteJobListOptions {
  readonly tenantId?: string;
  readonly status?: RewriteJobStatus;
  readonly limit?: number;
  readonly offset?: number;
}

export interface RewriteJobProgress {
  readonly lastRowId: string | null;
  readonly rowsRewritten: number;
}

export interface RewriteJobStore {
  list(opts?: RewriteJobListOptions): Promise<ReadonlyArray<RewriteJobRecord>>;
  get(id: string): Promise<RewriteJobRecord | null>;
  upsert(job: RewriteJobRecord): Promise<void>;
  /** Advance progress in-place; updates `last_row_id`, `rows_rewritten`, `updated_at`, status='running'. */
  recordProgress(id: string, progress: RewriteJobProgress, now: number): Promise<void>;
  markComplete(id: string, totalRowsRewritten: number, now: number): Promise<void>;
  markFailed(id: string, errorMessage: string, now: number): Promise<void>;
}

/** Reference in-memory implementation. Suitable for tests + examples. */
export class InMemoryRewriteJobStore implements RewriteJobStore {
  readonly #jobs = new Map<string, RewriteJobRecord>();

  async list(opts: RewriteJobListOptions = {}): Promise<ReadonlyArray<RewriteJobRecord>> {
    let rows = Array.from(this.#jobs.values());
    if (opts.tenantId) rows = rows.filter((r) => r.tenantId === opts.tenantId);
    if (opts.status) rows = rows.filter((r) => r.status === opts.status);
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? rows.length;
    return rows.slice(offset, offset + limit);
  }

  async get(id: string): Promise<RewriteJobRecord | null> {
    return this.#jobs.get(id) ?? null;
  }

  async upsert(job: RewriteJobRecord): Promise<void> {
    this.#jobs.set(job.id, job);
  }

  async recordProgress(id: string, progress: RewriteJobProgress, now: number): Promise<void> {
    const existing = this.#jobs.get(id);
    if (!existing) return;
    this.#jobs.set(id, {
      ...existing,
      lastRowId: progress.lastRowId,
      rowsRewritten: progress.rowsRewritten,
      status: 'running',
      updatedAt: now,
    });
  }

  async markComplete(id: string, totalRowsRewritten: number, now: number): Promise<void> {
    const existing = this.#jobs.get(id);
    if (!existing) return;
    this.#jobs.set(id, {
      ...existing,
      rowsRewritten: totalRowsRewritten,
      status: 'complete',
      updatedAt: now,
      completedAt: now,
    });
  }

  async markFailed(id: string, errorMessage: string, now: number): Promise<void> {
    const existing = this.#jobs.get(id);
    if (!existing) return;
    this.#jobs.set(id, {
      ...existing,
      status: 'failed',
      errorMessage,
      updatedAt: now,
    });
  }
}
