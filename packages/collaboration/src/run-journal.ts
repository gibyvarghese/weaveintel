/**
 * @weaveintel/collaboration — Run event journal (W3)
 *
 * Append-only journal of `StreamEnvelope`s per run, keyed by
 * `<ns>:<runId>:<paddedSequence>`.  Clients read from a `RunEventCursor`
 * to resume a stream without gaps.
 *
 * Design notes:
 * - The journal is for *stream resume*, not audit.  Audit belongs in
 *   `@weaveintel/observability`/`@weaveintel/replay`.
 * - Entries are TTL-evicted after `retentionMs` (default 24 h) via the
 *   KV `ttlMs` option.  Actual eviction timing is backend-specific and
 *   lazy; do not rely on exact expiry for correctness.
 * - `maxEnvelopesPerRun` (default 2 000) caps the journal per run; when
 *   exceeded, the oldest entries are silently dropped on the next append.
 *   Producers should checkpoint externally for long-running streams.
 * - Sequence numbers are padded to 10 digits so KV lex-sort produces
 *   correct ascending order for `readAfter`.
 *
 * @weaveintel/core imports keep this package free of external deps.
 */

import {
  weaveInMemoryPersistence,
  type RuntimeKvStore,
  type WeaveRuntime,
  type StreamEnvelope,
  type RunEventCursor,
  type ExecutionContext,
} from '@weaveintel/core';

// ─── Options ──────────────────────────────────────────────────────────────────

export interface RunJournalOptions {
  runtime?: WeaveRuntime;
  /** KV namespace prefix. Default: `'run-journal'`. */
  namespace?: string;
  /** Entry TTL in ms. Default: 24 hours. */
  retentionMs?: number;
  /** Max envelopes stored per run. Default: 2 000. */
  maxEnvelopesPerRun?: number;
}

// ─── Interface ────────────────────────────────────────────────────────────────

export interface RunJournal {
  /** Append a `StreamEnvelope` to the run's journal. */
  appendEnvelope(ctx: ExecutionContext, runId: string, envelope: StreamEnvelope): Promise<void>;
  /**
   * Read envelopes with `sequence > cursor.afterSequence`, up to `limit`.
   * Returns in ascending sequence order.  `limit` defaults to 100.
   */
  readAfter(ctx: ExecutionContext, cursor: RunEventCursor, limit?: number): Promise<StreamEnvelope[]>;
  /**
   * Purge all journal entries for a run (e.g. after run is deleted or archived).
   */
  purgeRun(ctx: ExecutionContext, runId: string): Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveKv(runtime: WeaveRuntime | undefined): RuntimeKvStore {
  return runtime?.persistence?.kv ?? weaveInMemoryPersistence().kv;
}

/** Pad sequence to 10 digits so KV lex-sort gives ascending order. */
function pad(seq: number): string {
  return seq.toString().padStart(10, '0');
}

function journalKey(ns: string, runId: string, seq: number): string {
  return `${ns}:${runId}:${pad(seq)}`;
}

function journalPrefix(ns: string, runId: string): string {
  return `${ns}:${runId}:`;
}

// ─── Implementation ────────────────────────────────────────────────────────────

export function createRunJournal(opts: RunJournalOptions = {}): RunJournal {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'run-journal';
  const retentionMs = opts.retentionMs ?? 24 * 60 * 60 * 1000;
  const maxPerRun = opts.maxEnvelopesPerRun ?? 2_000;

  return {
    async appendEnvelope(_ctx, runId, envelope) {
      const key = journalKey(ns, runId, envelope.sequence);
      await kv.set(key, JSON.stringify(envelope), { ttlMs: retentionMs });

      // Size cap: if we've exceeded maxPerRun, prune oldest entries.
      // This is best-effort — we don't want this to crash the append path.
      try {
        const all = await kv.list(journalPrefix(ns, runId));
        if (all.length > maxPerRun) {
          const toPrune = all.slice(0, all.length - maxPerRun);
          for (const entry of toPrune) {
            await kv.delete(entry.key);
          }
        }
      } catch {
        // Pruning is best-effort; never fail the append.
      }
    },

    async readAfter(_ctx, cursor, limit = 100) {
      const all = await kv.list(journalPrefix(ns, cursor.runId));
      // KV list returns lex-sorted entries; filter by sequence > afterSequence
      const filtered: StreamEnvelope[] = [];
      for (const entry of all) {
        try {
          const env = JSON.parse(entry.value) as StreamEnvelope;
          if (env.sequence > cursor.afterSequence) {
            filtered.push(env);
          }
        } catch { /* skip corrupt */ }
        if (filtered.length >= limit) break;
      }
      // Return in ascending sequence order (KV list is lex-sorted so already ordered)
      return filtered.sort((a, b) => a.sequence - b.sequence);
    },

    async purgeRun(_ctx, runId) {
      const all = await kv.list(journalPrefix(ns, runId));
      for (const entry of all) {
        try { await kv.delete(entry.key); } catch { /* best-effort */ }
      }
    },
  };
}
