/**
 * Redis-backed CostLedger.
 *
 * Layout:
 *   ledger:entry:<id>             STRING — JSON of CostLedgerEntry (sans id)
 *   ledger:run:<runId>            ZSET   — score = observedAt, member = entry id
 *
 * Caller passes a node-redis v4 client (already connected). Package does not
 * own connection lifecycle.
 *
 * Idempotent: SET NX on entry key; ZADD NX on run zset.
 * Best-effort: record() swallows errors.
 */
import type { RedisClientType } from 'redis';
import type {
  CostLedger,
  CostLedgerEntry,
  CostBreakdown,
  CostLever,
} from '../types.js';

export interface WeaveRedisCostLedgerOptions {
  client: RedisClientType;
  keyPrefix?: string;
}

export function weaveRedisCostLedger(opts: WeaveRedisCostLedgerOptions): CostLedger {
  const prefix = opts.keyPrefix ?? '';
  const client = opts.client;
  const k = (s: string) => `${prefix}${s}`;

  return {
    async record(entry: CostLedgerEntry): Promise<void> {
      try {
        // strip id from value blob — id lives in the key
        const { id: _id, ...rest } = entry;
        void _id;
        const setResult = await client.set(k(`ledger:entry:${entry.id}`), JSON.stringify(rest), { NX: true });
        if (setResult === null) return; // already present — idempotent
        await client.zAdd(k(`ledger:run:${entry.runId}`), { score: entry.observedAt, value: entry.id });
      } catch {
        // best-effort
      }
    },
    async total(runId: string): Promise<number> {
      const ids = await client.zRange(k(`ledger:run:${runId}`), 0, -1);
      if (ids.length === 0) return 0;
      const blobs = await client.mGet(ids.map((id) => k(`ledger:entry:${id}`)));
      let total = 0;
      for (const b of blobs) {
        if (!b) continue;
        try {
          const e = JSON.parse(b) as Omit<CostLedgerEntry, 'id'>;
          total += e.costUsd;
        } catch { /* skip */ }
      }
      return total;
    },
    async breakdown(runId: string): Promise<CostBreakdown> {
      const ids = await client.zRange(k(`ledger:run:${runId}`), 0, -1);
      const entries: CostLedgerEntry[] = [];
      if (ids.length > 0) {
        const blobs = await client.mGet(ids.map((id) => k(`ledger:entry:${id}`)));
        for (let i = 0; i < ids.length; i++) {
          const b = blobs[i];
          const id = ids[i];
          if (!b || !id) continue;
          try {
            const rest = JSON.parse(b) as Omit<CostLedgerEntry, 'id'>;
            entries.push({ id, ...rest });
          } catch { /* skip */ }
        }
      }
      const byLever: Record<string, number> = {};
      const byModel: Record<string, number> = {};
      const bySubject: Record<string, number> = {};
      const byAgent: Record<string, number> = {};
      let totalUsd = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedTokens = 0;
      let reasoningTokens = 0;
      for (const e of entries) {
        totalUsd += e.costUsd;
        byLever[e.lever] = (byLever[e.lever] ?? 0) + e.costUsd;
        bySubject[e.subject] = (bySubject[e.subject] ?? 0) + e.costUsd;
        if (e.source === 'model') byModel[e.subject] = (byModel[e.subject] ?? 0) + e.costUsd;
        if (e.agentId) byAgent[e.agentId] = (byAgent[e.agentId] ?? 0) + e.costUsd;
        inputTokens += e.inputTokens ?? 0;
        outputTokens += e.outputTokens ?? 0;
        cachedTokens += e.cachedTokens ?? 0;
        reasoningTokens += e.reasoningTokens ?? 0;
      }
      return {
        runId,
        totalUsd,
        entryCount: entries.length,
        byLever: byLever as Record<CostLever, number>,
        byModel,
        bySubject,
        byAgent,
        tokens: { input: inputTokens, output: outputTokens, cached: cachedTokens, reasoning: reasoningTokens },
        entries,
      };
    },
  };
}
