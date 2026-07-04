/**
 * Run event journal — the canonical append-only run-event log contract.
 *
 * Collaboration Phase 0: this used to live in `@weaveintel/collab` as a
 * second, parallel implementation of the run journal that a host application already had
 * in SQL. The journal is *run-lifecycle substrate*, not a collaboration concern,
 * and its vocabulary (`RunEventEnvelope`, `RunEventCursor`) already lives here —
 * so the PORT (interface) + a reference KV adapter now live in `@weaveintel/core`,
 * and the host app's SQL tables are just another adapter behind the same interface.
 *
 * --- For someone new to this ---
 * A "journal" here is an append-only list of everything that happened during a
 * run (each token, tool call, status change…), numbered 0, 1, 2, … A client that
 * disconnects can reconnect and say "I last saw event 41 — give me everything
 * after that" (`readAfter`), so it never misses or repeats an event. That single
 * idea — a numbered, append-only log you can resume from — is what makes a live
 * agent stream survive a dropped connection.
 *
 * Two implementations conform to the {@link RunJournal} port:
 *  - {@link createKvRunJournal} (here) — a key-value reference adapter, used by
 *    non-SQL hosts and as the fast in-memory test double.
 *  - a host application's `SqlRunJournal` — backed by the `user_run_events` table.
 * Both are validated by the same {@link runJournalContract} conformance suite.
 *
 * Standards followed (see the mid-2026 research): per-run contiguous sequence,
 * EXCLUSIVE cursor (`readAfter(N)` ⇒ events with `sequence > N`), retention +
 * size cap, and — crucially — **gap-safe resume**: if a cursor falls below the
 * oldest still-retained event (because the size cap pruned it), `readAfter`
 * throws {@link RunCursorTooOldError} instead of silently skipping events.
 */
import { weaveInMemoryPersistence } from './runtime.js';
import type { RuntimeKvStore, WeaveRuntime } from './runtime.js';
import type { RunEventEnvelope } from './run-events.js';
import { RUN_STREAM_CONFIG_DEFAULTS } from './run-events.js';
import type { RunEventCursor } from './runs.js';

// ─── Defaults (ONE place — also seeds the host app's `run_stream_config` row) ────

/**
 * Journal defaults, derived from {@link RUN_STREAM_CONFIG_DEFAULTS} so retention
 * and the per-run cap are defined exactly once. The host app's `run_stream_config`
 * table (`journal_retention_hours` / `journal_max_events`) seeds from the same
 * source — there is no second hardcoded copy.
 */
export const RUN_JOURNAL_DEFAULTS = {
  retentionMs: RUN_STREAM_CONFIG_DEFAULTS.journalRetentionHours * 60 * 60 * 1000,
  maxEnvelopesPerRun: RUN_STREAM_CONFIG_DEFAULTS.journalMaxEvents,
} as const;

// ─── Typed errors ──────────────────────────────────────────────────────────────

/**
 * Thrown by `readAfter` when the requested `afterSequence` is older than the
 * oldest event still retained (the size cap or TTL pruned it). The consumer must
 * recover by re-reading from the beginning (`afterSequence: -1`) — its prior
 * cursor is unrecoverable. This is the "gap-safe resume" guarantee: a laggy
 * client gets a loud, typed error instead of a silently-skipped event gap.
 */
export class RunCursorTooOldError extends Error {
  readonly runId: string;
  readonly requestedAfter: number;
  readonly minRetainedSequence: number;
  constructor(runId: string, requestedAfter: number, minRetainedSequence: number) {
    super(
      `Run '${runId}' cursor too old: afterSequence ${requestedAfter} < oldest retained ${minRetainedSequence}. ` +
        `Re-read from the beginning (afterSequence: -1).`,
    );
    this.name = 'RunCursorTooOldError';
    this.runId = runId;
    this.requestedAfter = requestedAfter;
    this.minRetainedSequence = minRetainedSequence;
  }
}

// ─── Port (the interface every adapter implements) ─────────────────────────────

export interface RunJournalAppendOptions {
  /**
   * Optimistic concurrency: if set, the append is rejected unless the run's
   * current head sequence equals `expectedSequence - 1`. Adapters that derive
   * the sequence server-side (like the SQL one) may ignore this.
   */
  expectedSequence?: number;
}

export interface RunJournalReadOptions {
  /** Max events to return. Default 100. */
  limit?: number;
}

export interface RunJournal {
  /**
   * Append one event to a run's journal. Returns the assigned `sequence`.
   * Implementations MUST keep the per-run sequence contiguous and monotonic.
   */
  append(envelope: RunEventEnvelope, opts?: RunJournalAppendOptions): Promise<{ sequence: number }>;
  /**
   * Read events with `sequence > cursor.afterSequence`, ascending, up to `limit`.
   * Throws {@link RunCursorTooOldError} when the cursor is below the retained
   * watermark (gap-safe resume).
   */
  readAfter(cursor: RunEventCursor, opts?: RunJournalReadOptions): Promise<RunEventEnvelope[]>;
  /** Delete every journal entry for a run (e.g. after archival). */
  purgeRun(runId: string): Promise<void>;
}

export interface KvRunJournalOptions {
  runtime?: WeaveRuntime;
  /** KV namespace prefix. Default `'run-journal'`. */
  namespace?: string;
  /** Entry TTL in ms. Default {@link RUN_JOURNAL_DEFAULTS}.retentionMs (24h). */
  retentionMs?: number;
  /** Max envelopes retained per run. Default {@link RUN_JOURNAL_DEFAULTS}.maxEnvelopesPerRun (2000). */
  maxEnvelopesPerRun?: number;
}

// ─── KV reference adapter ──────────────────────────────────────────────────────

function resolveKv(runtime: WeaveRuntime | undefined): RuntimeKvStore {
  return runtime?.persistence?.kv ?? weaveInMemoryPersistence().kv;
}

/** Pad sequence to 10 digits so KV lexical order == ascending sequence order. */
function pad(seq: number): string {
  return seq.toString().padStart(10, '0');
}

export function createKvRunJournal(opts: KvRunJournalOptions = {}): RunJournal {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'run-journal';
  const retentionMs = opts.retentionMs ?? RUN_JOURNAL_DEFAULTS.retentionMs;
  const maxPerRun = opts.maxEnvelopesPerRun ?? RUN_JOURNAL_DEFAULTS.maxEnvelopesPerRun;

  const key = (runId: string, seq: number) => `${ns}:${runId}:${pad(seq)}`;
  const prefix = (runId: string) => `${ns}:${runId}:`;

  /** The lowest sequence still retained for a run (the prune watermark), or -1. */
  async function minRetained(runId: string): Promise<number> {
    const all = await kv.list(prefix(runId));
    if (all.length === 0) return -1;
    let min = Number.MAX_SAFE_INTEGER;
    for (const e of all) {
      try {
        const seq = (JSON.parse(e.value) as RunEventEnvelope).sequence;
        if (seq < min) min = seq;
      } catch { /* skip corrupt */ }
    }
    return min === Number.MAX_SAFE_INTEGER ? -1 : min;
  }

  return {
    async append(envelope, appendOpts) {
      const { runId, sequence } = envelope;
      if (appendOpts?.expectedSequence !== undefined && sequence !== appendOpts.expectedSequence) {
        throw new Error(
          `Run '${runId}' sequence conflict: expected ${appendOpts.expectedSequence}, got ${sequence}`,
        );
      }
      await kv.set(key(runId, sequence), JSON.stringify(envelope), { ttlMs: retentionMs });

      // Size cap: prune the oldest entries past the per-run limit (best-effort —
      // never fail the append). This is what can advance the retained watermark.
      try {
        const all = await kv.list(prefix(runId));
        if (all.length > maxPerRun) {
          for (const entry of all.slice(0, all.length - maxPerRun)) {
            await kv.delete(entry.key);
          }
        }
      } catch { /* best-effort prune */ }

      return { sequence };
    },

    async readAfter(cursor, readOpts) {
      const limit = readOpts?.limit ?? 100;
      const all = await kv.list(prefix(cursor.runId));

      // Gap-safe resume: if the caller's cursor is below the oldest retained
      // event, the events between are gone — surface a typed error rather than
      // silently returning a gap. (afterSequence < 0 == "from the beginning",
      // always valid.)
      if (cursor.afterSequence >= 0 && all.length > 0) {
        const min = await minRetained(cursor.runId);
        if (min > 0 && cursor.afterSequence < min - 1) {
          throw new RunCursorTooOldError(cursor.runId, cursor.afterSequence, min);
        }
      }

      const out: RunEventEnvelope[] = [];
      for (const entry of all) {
        try {
          const env = JSON.parse(entry.value) as RunEventEnvelope;
          if (env.sequence > cursor.afterSequence) out.push(env);
        } catch { /* skip corrupt */ }
        if (out.length >= limit) break;
      }
      return out.sort((a, b) => a.sequence - b.sequence);
    },

    async purgeRun(runId) {
      const all = await kv.list(prefix(runId));
      for (const entry of all) {
        try { await kv.delete(entry.key); } catch { /* best-effort */ }
      }
    },
  };
}
