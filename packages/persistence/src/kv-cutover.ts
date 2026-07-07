// SPDX-License-Identifier: MIT
/**
 * Moving the runtime's durable state from one database to another — safely, with zero loss (Phase 5).
 *
 * --- The plain-English version ---
 * Once you've decided to run on Postgres (Phases 0–4 make every backend a proven drop-in), you still
 * have to *move the data you already have* — the dead-letter queue, the cost meter, the idempotency
 * records — from the old database to the new one, without dropping anything and, ideally, without a
 * maintenance window. This module is the small, boring toolkit that makes that switch a checklist
 * instead of a leap of faith. It works over the same `RuntimeKvStore` port every backend already
 * implements, so it doesn't care whether you're going SQLite→Postgres, Postgres→Postgres, or anything
 * else.
 *
 * The industry-standard playbook (expand → migrate → verify → cut over → contract) maps to three tools:
 *   1. `weaveDualWriteKv(old, new)` — a store that writes to BOTH while you keep reading the old one, so
 *      the new database stays current from the moment you start (the "expand" / dual-write step).
 *   2. `migrateKv(old, new)` — copy everything that was there before you turned on dual-writes (the
 *      "backfill").
 *   3. `reconcileKv(old, new)` — compare the two, key by key, and tell you exactly what (if anything)
 *      differs, so you only cut over when they're proven identical (the "verify" step).
 * Then you flip reads to the new database, keep the old one around read-only for a bit as a rollback
 * safety net, and finally stop writing to it.
 *
 * Note on expiry: the port lists keys and values but not their remaining time-to-live, so migrated keys
 * are copied WITHOUT a TTL. Migrate durable, non-expiring state (DLQ, cost meter, idempotency ledger);
 * re-establish any short-lived TTLs on the new side after cutover if you need them.
 */

import type { RuntimeKvStore } from '@weaveintel/core';

// ── Backfill (copy) ──────────────────────────────────────────────────────────────

export interface MigrateKvOptions {
  /** Only migrate keys under this prefix. Default `''` (everything). */
  readonly prefix?: string;
  /** How many keys to copy per concurrent batch. Default 500. */
  readonly batchSize?: number;
  /** When false, existing keys in the target are left untouched (skipped). Default true (overwrite). */
  readonly overwrite?: boolean;
  /** Count what WOULD be copied without writing anything. Default false. */
  readonly dryRun?: boolean;
  /** Progress callback, invoked after each batch with running totals. */
  readonly onProgress?: (done: number, total: number) => void;
}

export interface MigrateKvResult {
  /** Total keys found in the source under the prefix. */
  readonly total: number;
  /** Keys written to the target. */
  readonly copied: number;
  /** Keys skipped because they already existed and `overwrite` was false. */
  readonly skipped: number;
  /** True when this was a dry run (nothing was written). */
  readonly dryRun: boolean;
}

/**
 * Copy every key/value from `source` into `target`. Idempotent — safe to run repeatedly (e.g. to catch
 * up after dual-writes are already flowing). Returns a summary you can log or assert on.
 *
 * @example
 * ```ts
 * const result = await migrateKv(sqliteSlot.kv, postgresSlot.kv, { onProgress: (d, t) => console.log(`${d}/${t}`) });
 * console.log(`copied ${result.copied} of ${result.total}`);
 * ```
 */
export async function migrateKv(
  source: RuntimeKvStore,
  target: RuntimeKvStore,
  opts: MigrateKvOptions = {},
): Promise<MigrateKvResult> {
  const prefix = opts.prefix ?? '';
  const batchSize = Math.max(1, opts.batchSize ?? 500);
  const overwrite = opts.overwrite ?? true;
  const dryRun = opts.dryRun ?? false;

  const rows = await source.list(prefix);
  const total = rows.length;
  let copied = 0;
  let skipped = 0;
  let done = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async ({ key, value }) => {
        if (!overwrite) {
          const existing = await target.get(key);
          if (existing !== undefined) { skipped += 1; return; }
        }
        if (!dryRun) await target.set(key, value);
        copied += 1;
      }),
    );
    done += batch.length;
    opts.onProgress?.(done, total);
  }

  return { total, copied, skipped, dryRun };
}

// ── Reconcile (verify) ───────────────────────────────────────────────────────────

export interface ReconcileKvOptions {
  /** Only compare keys under this prefix. Default `''` (everything). */
  readonly prefix?: string;
  /** Cap how many example keys to list per category (keeps the report small). Default 100. */
  readonly maxSamples?: number;
}

export interface ReconcileKvReport {
  /** True when the two stores are identical under the prefix (safe to cut over). */
  readonly ok: boolean;
  readonly sourceCount: number;
  readonly targetCount: number;
  /** Keys present in the source but missing from the target (data that would be lost). */
  readonly missingInTarget: readonly string[];
  /** Keys present in the target but not in the source (unexpected extras). */
  readonly extraInTarget: readonly string[];
  /** Keys present in both but with different values. */
  readonly valueMismatches: readonly string[];
  /** True when a category was truncated to `maxSamples` (there may be more than shown). */
  readonly truncated: boolean;
}

/**
 * Compare two stores key-by-key and report exactly what differs. `ok: true` is your green light to cut
 * over. Run it AFTER `migrateKv` + while dual-writes are flowing, so the two are expected to match.
 */
export async function reconcileKv(
  source: RuntimeKvStore,
  target: RuntimeKvStore,
  opts: ReconcileKvOptions = {},
): Promise<ReconcileKvReport> {
  const prefix = opts.prefix ?? '';
  const cap = Math.max(1, opts.maxSamples ?? 100);
  const [srcRows, tgtRows] = await Promise.all([source.list(prefix), target.list(prefix)]);
  const src = new Map(srcRows.map((r) => [r.key, r.value]));
  const tgt = new Map(tgtRows.map((r) => [r.key, r.value]));

  const missingInTarget: string[] = [];
  const valueMismatches: string[] = [];
  const extraInTarget: string[] = [];
  let truncated = false;
  const push = (arr: string[], key: string) => { if (arr.length < cap) arr.push(key); else truncated = true; };

  for (const [key, value] of src) {
    if (!tgt.has(key)) push(missingInTarget, key);
    else if (tgt.get(key) !== value) push(valueMismatches, key);
  }
  for (const key of tgt.keys()) if (!src.has(key)) push(extraInTarget, key);

  return {
    ok: missingInTarget.length === 0 && extraInTarget.length === 0 && valueMismatches.length === 0,
    sourceCount: src.size,
    targetCount: tgt.size,
    missingInTarget,
    extraInTarget,
    valueMismatches,
    truncated,
  };
}

// ── Dual-write (expand) ──────────────────────────────────────────────────────────

export interface DualWriteKvOptions {
  /**
   * Fraction of reads to also fetch from the secondary and compare (0–1). Default 0 (no shadow reads).
   * Sampling is deterministic (every Nth read), not random, so tests are reproducible.
   */
  readonly shadowReadRatio?: number;
  /** Called when a shadow read finds the two stores disagree on a key. */
  readonly onMismatch?: (key: string, primary: string | undefined, secondary: string | undefined) => void;
  /** Called when a write to the secondary fails (it's best-effort by default). */
  readonly onSecondaryError?: (op: 'set' | 'delete', key: string, error: unknown) => void;
  /** When true, a failed secondary write throws instead of being swallowed. Default false. */
  readonly failOnSecondaryError?: boolean;
}

/**
 * A `RuntimeKvStore` that writes to BOTH `primary` and `secondary`, but reads from `primary`. Use it
 * during a migration so the new database stays current from the moment you switch it on, while the old
 * one is still the source of truth. The secondary is best-effort (a failed secondary write doesn't break
 * the request) unless you set `failOnSecondaryError`.
 *
 * Expand phase: `weaveDualWriteKv(old, new)` — read old, write both. After backfill + reconcile, flip to
 * reading `new` directly. For a rollback safety window, run `weaveDualWriteKv(new, old)` so the old store
 * keeps receiving writes while you watch the new one.
 */
export function weaveDualWriteKv(
  primary: RuntimeKvStore,
  secondary: RuntimeKvStore,
  opts: DualWriteKvOptions = {},
): RuntimeKvStore {
  const ratio = Math.min(1, Math.max(0, opts.shadowReadRatio ?? 0));
  // Deterministic 1-in-N sampling (N = round(1/ratio)); ratio 0 disables, ratio 1 = every read.
  const everyN = ratio <= 0 ? 0 : ratio >= 1 ? 1 : Math.round(1 / ratio);
  let reads = 0;

  const toSecondary = async (op: 'set' | 'delete', key: string, fn: () => Promise<unknown>) => {
    try { await fn(); }
    catch (error) {
      opts.onSecondaryError?.(op, key, error);
      if (opts.failOnSecondaryError) throw error;
    }
  };

  return {
    async get(key) {
      const value = await primary.get(key);
      if (everyN > 0) {
        reads += 1;
        if (reads % everyN === 0) {
          const shadow = await secondary.get(key);
          if (shadow !== value) opts.onMismatch?.(key, value, shadow);
        }
      }
      return value;
    },
    async set(key, value, setOpts) {
      await primary.set(key, value, setOpts);
      await toSecondary('set', key, () => secondary.set(key, value, setOpts));
    },
    async delete(key) {
      const removed = await primary.delete(key);
      await toSecondary('delete', key, () => secondary.delete(key));
      return removed;
    },
    list(prefix) {
      return primary.list(prefix);
    },
  };
}
