/**
 * @weaveintel/encryption — purge scheduler (storage-agnostic).
 *
 * Runs on a fixed interval and asks the host (via injected callbacks) for
 * tenant-deletion requests whose retention window has expired. For each one
 * it calls `manager.hardShred(tenantId)` and then asks the host to mark the
 * deletion request as purged. Per-tenant errors are isolated.
 *
 * The package never imports a DB adapter — hosts wire `listDuePurges` and
 * `markPurged` over their own persistence (SQLite, Postgres, Mongo, …).
 */

import type { TenantKeyManager } from './key-manager.js';
import type { AuditEmitter } from './audit.js';

export const PURGE_SCHEDULER_ACTOR = 'system:purge-scheduler';

/** Minimal shape of a due tenant-deletion request the scheduler needs. */
export interface DueTenantPurge {
  readonly id: string;
  readonly tenantId: string;
  readonly requestedAt: number;
  readonly retentionUntil: number;
}

export interface PurgeSchedulerTickResult {
  readonly checked: number;
  readonly purged: number;
  readonly errors: number;
  readonly skipped?: 'manager_unavailable';
}

export interface WeavePurgeSchedulerOptions {
  /** Live-binding getter so the scheduler picks up post-bootstrap manager. */
  readonly getManager: () => TenantKeyManager | null;
  /** Returns deletion requests whose retentionUntil <= now AND status='pending'. */
  readonly listDuePurges: (now: number) => Promise<readonly DueTenantPurge[]>;
  /** Marks a deletion request as purged (status='purged', purgedAt=now). */
  readonly markPurged: (requestId: string, now: number) => Promise<void>;
  /** Optional audit emitter for scheduler-level events. */
  readonly audit?: AuditEmitter;
  /** Tick interval in ms. Default 1 hour. */
  readonly intervalMs?: number;
  /** Clock injection for tests. */
  readonly now?: () => number;
  /** Optional logger. */
  readonly log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface WeavePurgeSchedulerHandle {
  readonly stop: () => void;
  readonly tickNow: () => Promise<PurgeSchedulerTickResult>;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export function weavePurgeScheduler(opts: WeavePurgeSchedulerOptions): WeavePurgeSchedulerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});

  async function runOnce(): Promise<PurgeSchedulerTickResult> {
    const manager = opts.getManager();
    if (!manager) {
      log('encryption:purge-scheduler manager unavailable, skipping tick');
      return { checked: 0, purged: 0, errors: 0, skipped: 'manager_unavailable' };
    }
    const t = now();
    let due: readonly DueTenantPurge[] = [];
    try {
      due = await opts.listDuePurges(t);
    } catch (err) {
      log('encryption:purge-scheduler list failed', { error: String(err) });
      return { checked: 0, purged: 0, errors: 1 };
    }
    let purged = 0;
    let errors = 0;
    for (const req of due) {
      try {
        const counts = await manager.hardShred(req.tenantId, PURGE_SCHEDULER_ACTOR);
        await opts.markPurged(req.id, now());
        purged += 1;
        log('encryption:purge-scheduler purged tenant', {
          tenantId: req.tenantId,
          requestId: req.id,
          ...counts,
        });
      } catch (err) {
        errors += 1;
        log('encryption:purge-scheduler tenant purge failed', {
          tenantId: req.tenantId,
          requestId: req.id,
          error: String(err),
        });
      }
    }
    return { checked: due.length, purged, errors };
  }

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (timer as any).unref === 'function') (timer as any).unref();

  return {
    stop: () => clearInterval(timer),
    tickNow: runOnce,
  };
}
