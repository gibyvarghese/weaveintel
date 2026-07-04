/**
 * @weaveintel/encryption — RewriteScheduler.
 *
 * Walks tenant-scoped rewrite jobs after a DEK rotation and re-encrypts
 * sentinel rows whose epoch is below the current target. Pure composition
 * over `TenantKeyManager` + `RewriteJobStore` + caller-supplied
 * `RewritableTableSpec` adapters — the package never imports a database.
 *
 * Reusability invariant: depends ONLY on `@weaveintel/core` (transitive
 * via key-manager) + `node:crypto`. Hosts (consuming applications,
 * tests) wire one `RewritableTableSpec` per encrypted (table, column)
 * pair.
 *
 * Per tick:
 *   1. List pending+running jobs (batched by `maxJobsPerTick`).
 *   2. For each job, look up the matching spec by (tableName, columnName).
 *   3. Page rows via `spec.listSentinelRows({ tenantId, column, fromEpoch, afterId, limit })`.
 *   4. For each row: parse sentinel epoch; if `< job.toEpoch`,
 *      decrypt with AAD bound to (tenant, table, column, rowId) and
 *      re-encrypt under the current active DEK. Call `spec.updateRow`.
 *      Throttle between rows (`throttleMs`).
 *   5. After every batch, persist `lastRowId + rowsRewritten` via
 *      `store.recordProgress`.
 *   6. When a page returns < limit rows, mark the job complete and emit
 *      a `rewrite_progress` audit event (if `audit` opt is supplied).
 *
 * Graceful: any row error is logged + skipped; any job error transitions
 * the job to `failed` but never throws out of `tickOnce()`.
 */

import { isEncrypted, parseSentinel } from './envelope.js';
import type { TenantKeyManager } from './key-manager.js';
import type { AuditEmitter } from './audit.js';
import type {
  RewriteJobRecord,
  RewriteJobStore,
} from './rewrite-store.js';

/** A single encrypted row surfaced by the host adapter. */
export interface SentinelRow {
  readonly rowId: string;
  readonly ciphertext: string;
}

/** Host-supplied adapter for one (table, column) being rewritten. */
export interface RewritableTableSpec {
  readonly tableName: string;
  readonly columnName: string;
  /** Page rows for this tenant whose stored value starts with the sentinel prefix. */
  listSentinelRows(opts: {
    readonly tenantId: string;
    readonly afterRowId: string | null;
    readonly limit: number;
  }): Promise<ReadonlyArray<SentinelRow>>;
  /** Persist a freshly-encrypted ciphertext in place. */
  updateRow(opts: {
    readonly tenantId: string;
    readonly rowId: string;
    readonly ciphertext: string;
  }): Promise<void>;
}

export interface WeaveRewriteSchedulerOptions {
  readonly manager: TenantKeyManager;
  readonly store: RewriteJobStore;
  readonly specs: ReadonlyArray<RewritableTableSpec>;
  readonly audit?: AuditEmitter;
  /** Rows fetched per page per job. Default 100. */
  readonly batchSize?: number;
  /** Pause between row encrypts in ms (back-pressure). Default 50ms. */
  readonly throttleMs?: number;
  /** Jobs processed per tick. Default 4. */
  readonly maxJobsPerTick?: number;
  /** Background tick interval in ms. Default 60_000 (1 minute). */
  readonly tickIntervalMs?: number;
  readonly now?: () => number;
  readonly log?: (msg: string, meta?: unknown) => void;
}

export interface RewriteScheduler {
  start(): void;
  stop(): void;
  /** Run one tick synchronously. Returns counters for tests/observability. */
  tickOnce(): Promise<RewriteTickResult>;
}

export interface RewriteTickResult {
  readonly jobsProcessed: number;
  readonly rowsRewritten: number;
  readonly jobsCompleted: number;
  readonly jobsFailed: number;
}

const DEFAULT_BATCH = 100;
const DEFAULT_THROTTLE_MS = 50;
const DEFAULT_MAX_JOBS = 4;
const DEFAULT_TICK_MS = 60_000;

export function weaveRewriteScheduler(opts: WeaveRewriteSchedulerOptions): RewriteScheduler {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
  const maxJobs = opts.maxJobsPerTick ?? DEFAULT_MAX_JOBS;
  const tickInterval = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});

  const specIndex = new Map<string, RewritableTableSpec>();
  for (const spec of opts.specs) {
    specIndex.set(`${spec.tableName}.${spec.columnName}`, spec);
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  async function processJob(job: RewriteJobRecord): Promise<{ rows: number; completed: boolean; failed: boolean }> {
    const spec = specIndex.get(`${job.tableName}.${job.columnName}`);
    if (!spec) {
      await opts.store.markFailed(job.id, `no spec registered for ${job.tableName}.${job.columnName}`, now());
      log('rewrite-scheduler: missing spec', { jobId: job.id, table: job.tableName, column: job.columnName });
      return { rows: 0, completed: false, failed: true };
    }

    let lastRowId = job.lastRowId;
    let totalRows = job.rowsRewritten;
    let pageRowsRewritten = 0;

    let page: ReadonlyArray<SentinelRow>;
    try {
      page = await spec.listSentinelRows({
        tenantId: job.tenantId,
        afterRowId: lastRowId,
        limit: batchSize,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await opts.store.markFailed(job.id, `listSentinelRows failed: ${msg}`, now());
      log('rewrite-scheduler: list failed', { jobId: job.id, error: msg });
      return { rows: 0, completed: false, failed: true };
    }

    for (const row of page) {
      try {
        if (!isEncrypted(row.ciphertext)) {
          // Plaintext row — skip but still advance cursor.
          lastRowId = row.rowId;
          continue;
        }
        const parsed = parseSentinel(row.ciphertext);
        if (parsed.epoch >= job.toEpoch) {
          // Already at or beyond target — skip.
          lastRowId = row.rowId;
          continue;
        }
        const plaintext = await opts.manager.decrypt({
          tenantId: job.tenantId,
          table: job.tableName,
          column: job.columnName,
          rowId: row.rowId,
          value: row.ciphertext,
        });
        const fresh = await opts.manager.encrypt({
          tenantId: job.tenantId,
          table: job.tableName,
          column: job.columnName,
          rowId: row.rowId,
          plaintext,
        });
        await spec.updateRow({
          tenantId: job.tenantId,
          rowId: row.rowId,
          ciphertext: fresh,
        });
        totalRows += 1;
        pageRowsRewritten += 1;
        lastRowId = row.rowId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('rewrite-scheduler: row failed; skipping', { jobId: job.id, rowId: row.rowId, error: msg });
        lastRowId = row.rowId; // advance to avoid infinite loop
      }

      if (throttleMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, throttleMs));
      }
    }

    await opts.store.recordProgress(
      job.id,
      { lastRowId, rowsRewritten: totalRows },
      now(),
    );

    const completed = page.length < batchSize;
    if (completed) {
      await opts.store.markComplete(job.id, totalRows, now());
      if (opts.audit) {
        try {
          await opts.audit.emit({
            id: `rewrite-${job.id}-${now()}`,
            tenantId: job.tenantId,
            eventKind: 'rewrite_progress',
            actor: null,
            details: {
              jobId: job.id,
              table: job.tableName,
              column: job.columnName,
              fromEpoch: job.fromEpoch,
              toEpoch: job.toEpoch,
              rowsRewritten: totalRows,
              status: 'complete',
            },
            createdAt: now(),
          });
        } catch (err) {
          log('rewrite-scheduler: audit emit failed', {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return { rows: pageRowsRewritten, completed, failed: false };
  }

  async function tickOnce(): Promise<RewriteTickResult> {
    if (inFlight) {
      return { jobsProcessed: 0, rowsRewritten: 0, jobsCompleted: 0, jobsFailed: 0 };
    }
    inFlight = true;
    let jobsProcessed = 0;
    let rowsRewritten = 0;
    let jobsCompleted = 0;
    let jobsFailed = 0;
    try {
      const pending = await opts.store.list({ status: 'pending', limit: maxJobs });
      const running = pending.length < maxJobs
        ? await opts.store.list({ status: 'running', limit: maxJobs - pending.length })
        : [];
      const jobs = [...pending, ...running];
      for (const job of jobs) {
        try {
          const res = await processJob(job);
          jobsProcessed += 1;
          rowsRewritten += res.rows;
          if (res.completed) jobsCompleted += 1;
          if (res.failed) jobsFailed += 1;
        } catch (err) {
          jobsFailed += 1;
          const msg = err instanceof Error ? err.message : String(err);
          log('rewrite-scheduler: job threw', { jobId: job.id, error: msg });
          try {
            await opts.store.markFailed(job.id, msg, now());
          } catch {
            /* swallow */
          }
        }
      }
    } finally {
      inFlight = false;
    }
    return { jobsProcessed, rowsRewritten, jobsCompleted, jobsFailed };
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      tickOnce().catch((err) => {
        log('rewrite-scheduler: tick threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, tickInterval);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, tickOnce };
}
