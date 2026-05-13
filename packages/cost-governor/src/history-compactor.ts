/**
 * Phase 6b — History Compaction (lever L5).
 *
 * Per-tick decision that trims long conversation histories to a bounded
 * window before feeding them to the model. The package owns three
 * strategies; consumers pick one in `historyCompaction.strategy` on the
 * cost policy.
 *
 *   - `'none'`         → pass-through (identity).
 *   - `'sliding'`      → keep the last `windowTurns` entries.
 *   - `'summary'`      → keep the last `windowTurns`, summarise the
 *                        dropped tail via the consumer-supplied summariser.
 *   - `'hierarchical'` → reserved for a future phase; degrades to
 *                        pass-through (returns input unchanged).
 *
 * Invariants (HARD — tests assert each):
 *
 *   1. The first message is preserved if its role is `'system'`. This
 *      protects the agent's role/instructions even when windowTurns is 0.
 *   2. The last 2 messages are ALWAYS preserved. This protects the
 *      current turn's user goal + the immediately-preceding tool/agent
 *      output the model is responding to.
 *   3. The compactor is NEVER load-bearing: missing config, unknown
 *      strategy, summariser throws, all return the original history
 *      with `dropped: []` and `summary: undefined`.
 *
 * Reusability invariant: this module imports only from the cost-governor's
 * own types. Apps wire it via the `bundle.historyCompactor` slot.
 */

import type { CostHistoryCompactor, CostLeverContext, HistoryItem } from './governor.js';
import type { HistoryCompactionConfig } from './policy.js';

/** Result of `decideCompaction`. The `messages` array is what to send to
 *  the model; `dropped` is what was trimmed; `summary` is the synthesised
 *  recap (only present for the `'summary'` strategy). */
export interface CompactedHistory {
  readonly messages: ReadonlyArray<HistoryItem>;
  readonly dropped: ReadonlyArray<HistoryItem>;
  readonly summary?: string;
  readonly reason: string;
}

/** Pluggable summariser. Apps inject their own (LLM-based, heuristic, etc).
 *  MUST return a short string describing the dropped messages. Errors are
 *  caught and treated as "no summary" — original history is returned. */
export type HistorySummarizer = (
  dropped: ReadonlyArray<HistoryItem>,
  ctx: CostLeverContext,
) => Promise<string> | string;

const MIN_PRESERVED_TAIL = 2;
const DEFAULT_WINDOW_TURNS = 12;

/**
 * Pure decision: given history + config (+ optional summariser for
 * `'summary'` strategy), return what to send to the model. Never throws.
 */
export async function decideCompaction(
  history: ReadonlyArray<HistoryItem>,
  config: HistoryCompactionConfig | null | undefined,
  ctx: CostLeverContext,
  summarizer?: HistorySummarizer,
): Promise<CompactedHistory> {
  const passThrough = (reason: string): CompactedHistory => ({
    messages: history,
    dropped: [],
    reason,
  });

  if (!config || typeof config !== 'object') return passThrough('no-config');
  const strategy = config.strategy;
  if (strategy === 'none') return passThrough('strategy=none');
  if (strategy === 'hierarchical') return passThrough('strategy=hierarchical (reserved)');
  if (strategy !== 'sliding' && strategy !== 'summary') {
    return passThrough(`unknown-strategy=${String(strategy)}`);
  }

  const windowTurns = config.windowTurns ?? DEFAULT_WINDOW_TURNS;
  if (!Number.isFinite(windowTurns) || windowTurns < 0) {
    return passThrough('invalid-windowTurns');
  }

  // Identify the first system message (if any) — always preserved.
  const firstSystem =
    history.length > 0 && history[0]?.role === 'system' ? history[0] : null;
  const headOffset = firstSystem ? 1 : 0;

  // Effective window must keep at least MIN_PRESERVED_TAIL messages.
  const effectiveWindow = Math.max(windowTurns, MIN_PRESERVED_TAIL);
  const tailLen = history.length - headOffset;
  if (tailLen <= effectiveWindow) {
    return passThrough(`under-window (${tailLen} <= ${effectiveWindow})`);
  }

  const keepTail = history.slice(history.length - effectiveWindow);
  const dropped = history.slice(headOffset, history.length - effectiveWindow);
  if (dropped.length === 0) {
    return passThrough('nothing-to-drop');
  }

  const head: HistoryItem[] = firstSystem ? [firstSystem] : [];
  const tail: HistoryItem[] = [...keepTail];

  if (strategy === 'sliding') {
    return {
      messages: [...head, ...tail],
      dropped,
      reason: `sliding window=${effectiveWindow} dropped=${dropped.length}`,
    };
  }

  // strategy === 'summary'
  if (!summarizer) {
    return {
      messages: [...head, ...tail],
      dropped,
      reason: `summary requested but no summariser supplied — fell back to sliding (dropped=${dropped.length})`,
    };
  }
  let summary: string | undefined;
  try {
    summary = await summarizer(dropped, ctx);
  } catch {
    // Summariser failed — return sliding-style result without a summary message.
    return {
      messages: [...head, ...tail],
      dropped,
      reason: `summariser-threw — fell back to sliding (dropped=${dropped.length})`,
    };
  }
  if (typeof summary !== 'string' || summary.length === 0) {
    return {
      messages: [...head, ...tail],
      dropped,
      reason: `summariser-empty — fell back to sliding (dropped=${dropped.length})`,
    };
  }
  const summaryItem: HistoryItem = {
    role: 'system',
    content: `[history-summary of ${dropped.length} earlier turns] ${summary}`,
    metadata: { compactionSummary: true, droppedCount: dropped.length },
  };
  return {
    messages: [...head, summaryItem, ...tail],
    dropped,
    summary,
    reason: `summary window=${effectiveWindow} dropped=${dropped.length}`,
  };
}

/**
 * Builds a `CostHistoryCompactor` (the `bundle.historyCompactor` slot) that
 * delegates to `decideCompaction` and returns the compacted messages array.
 * Errors thrown anywhere internally fall back to the original history.
 */
export function weaveHistoryCompactor(
  config: HistoryCompactionConfig,
  summarizer?: HistorySummarizer,
  opts?: { log?: (msg: string) => void },
): CostHistoryCompactor {
  const log = opts?.log ?? ((m) => console.warn(`[cost-governor:history-compactor] ${m}`));
  return async (history, ctx): Promise<ReadonlyArray<HistoryItem>> => {
    try {
      const result = await decideCompaction(history, config, ctx, summarizer);
      return result.messages;
    } catch (err) {
      log(`decideCompaction threw: ${err instanceof Error ? err.message : String(err)} — passing through`);
      return history;
    }
  };
}
