/**
 * Phase 7 — Tool Output Truncation (lever L8).
 *
 * Two complementary helpers:
 *
 *   1. `truncateText(text, maxBytes)` — UTF-8-safe byte-bounded truncation
 *      with a marker suffix. Used to cap a single tool result before it
 *      reaches the LLM history.
 *
 *   2. `wrapToolRegistryWithOutputTruncation(registry, config)` — returns a
 *      new `ToolRegistry` whose tools' `execute()` returns are passed
 *      through `truncateText` per turn so verbose tool outputs (kaggle
 *      kernel logs, web fetches) cannot blow up the per-turn token bill.
 *
 *   3. `applyOutputTruncationToHistory(messages, keepLastN)` — keeps the
 *      first system message + the last N tool/assistant messages.
 *      Domain-agnostic; consumers feed their own history shape.
 *
 * Reusability invariant: imports only from `@weaveintel/core` and the
 * cost-governor's own types. NEVER load-bearing — null/zero config and
 * thrown errors degrade to pass-through.
 */

import type { ExecutionContext, Tool, ToolInput, ToolOutput, ToolRegistry } from '@weaveintel/core';
import { weaveToolRegistry } from '@weaveintel/core';
import type { ToolOutputTruncationConfig } from './policy.js';

export const TRUNCATION_MARKER = '\n[…truncated by cost-governor…]';

export interface TruncationResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
}

/**
 * UTF-8-safe truncation: never splits a multi-byte char. Appends a
 * marker when truncation actually occurs.
 */
export function truncateText(text: string, maxBytes: number): TruncationResult {
  if (typeof text !== 'string') {
    return { text: '', truncated: false, originalBytes: 0 };
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return { text, truncated: false, originalBytes: Buffer.byteLength(text, 'utf8') };
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) {
    return { text, truncated: false, originalBytes: bytes };
  }
  // Walk chars until we've reserved room for the marker.
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  const budget = Math.max(0, maxBytes - markerBytes);
  let used = 0;
  let cut = text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const cb = Buffer.byteLength(ch, 'utf8');
    if (used + cb > budget) {
      cut = i;
      break;
    }
    used += cb;
  }
  return {
    text: text.slice(0, cut) + TRUNCATION_MARKER,
    truncated: true,
    originalBytes: bytes,
  };
}

/**
 * Wrap each tool in a registry so `result.content` is byte-truncated per
 * call. `config.maxBytesPerTurn` is the per-tool-call cap. When the cap
 * is missing or non-positive, the source registry is returned unchanged
 * (pass-through, never load-bearing).
 *
 * `keepLastN` is *advisory only* at this layer — it applies to history
 * pruning, which consumers handle via `applyOutputTruncationToHistory`.
 */
export function wrapToolRegistryWithOutputTruncation(
  source: ToolRegistry,
  config: ToolOutputTruncationConfig | null | undefined,
): ToolRegistry {
  const cap = config?.maxBytesPerTurn ?? 0;
  if (!Number.isFinite(cap) || cap <= 0) return source;

  const target = weaveToolRegistry();
  for (const t of source.list()) {
    target.register(wrapToolWithTruncation(t, cap));
  }
  return target;
}

function wrapToolWithTruncation(tool: Tool, cap: number): Tool {
  const wrapped: Tool = {
    schema: tool.schema,
    invoke: async (ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> => {
      const result = await tool.invoke(ctx, input);
      const content = typeof result.content === 'string' ? result.content : '';
      const t = truncateText(content, cap);
      if (!t.truncated) return result;
      return {
        ...result,
        content: t.text,
        metadata: {
          ...(result.metadata ?? {}),
          truncated: true,
          originalBytes: t.originalBytes,
          maxBytesPerTurn: cap,
        },
      };
    },
  };
  return wrapped;
}

/** Generic history item shape — domain-agnostic. */
export interface HistoryMessageLike {
  readonly role: string;
  readonly content?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Keep the first system message plus the last N non-system messages.
 * When `keepLastN` is missing or non-positive, the original list is
 * returned unchanged.
 */
export function applyOutputTruncationToHistory<T extends HistoryMessageLike>(
  messages: ReadonlyArray<T>,
  keepLastN: number | undefined,
): ReadonlyArray<T> {
  if (!Number.isFinite(keepLastN) || (keepLastN ?? 0) <= 0) return messages;
  const n = keepLastN as number;
  const firstSystemIdx = messages.findIndex((m) => m.role === 'system');
  const nonSystem = messages.filter((m) => m.role !== 'system');
  if (nonSystem.length <= n) return messages;
  const tail = nonSystem.slice(-n);
  if (firstSystemIdx >= 0 && messages[firstSystemIdx]) {
    return [messages[firstSystemIdx]!, ...tail] as ReadonlyArray<T>;
  }
  return tail as ReadonlyArray<T>;
}

/**
 * Reusable function shape for the bundle slot.
 * Truncates a single tool result string. Returns `null` when no
 * truncation should happen (config disabled or input small enough).
 */
export type ToolOutputTruncator = (text: string) => TruncationResult;

export function weaveToolOutputTruncator(config: ToolOutputTruncationConfig | null | undefined): ToolOutputTruncator {
  const cap = config?.maxBytesPerTurn ?? 0;
  if (!Number.isFinite(cap) || cap <= 0) {
    return (text: string) => ({ text, truncated: false, originalBytes: Buffer.byteLength(text ?? '', 'utf8') });
  }
  return (text: string) => truncateText(text, cap);
}
