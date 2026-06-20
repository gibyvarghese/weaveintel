/**
 * Context window management for the agent loop.
 *
 * Three strategies for keeping message history within token budgets:
 *  - trim_oldest:    remove the oldest non-system message groups first
 *  - sliding_window: keep only the N most-recent non-system groups
 *  - summarize:      condense old turns via memory.summarize() then trim_oldest as fallback
 *
 * Invariants:
 *  - System messages are NEVER removed.
 *  - assistant (tool-call) + tool-result messages are NEVER split — they are
 *    treated as a single atomic group so the context never contains a dangling
 *    tool_use without its paired tool_result.
 */

import type { Message, AgentMemory, ExecutionContext } from '@weaveintel/core';

export interface ContextManagementOptions {
  /** Which eviction strategy to use when the context is too large. */
  strategy: 'trim_oldest' | 'summarize' | 'sliding_window';
  /**
   * Token budget threshold.  When the estimated token count of the current
   * message list exceeds this value, compression kicks in.
   * Default: 100 000 tokens.
   */
  maxTokens?: number;
  /**
   * For `sliding_window`: number of most-recent non-system message GROUPS to
   * keep.  A group is an atomic unit (see invariant above).
   * Default: 20.
   */
  slidingWindowSize?: number;
}

// ─── Token estimation ─────────────────────────────────────────────────────────

/** Rough estimate: 1 token ≈ 4 characters (works for English/code content). */
export function estimateTokens(messages: readonly Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    const c = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    chars += c.length;
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        chars += tc.name.length + tc.arguments.length + 20; // overhead for JSON structure
      }
    }
  }
  return Math.ceil(chars / 4);
}

// ─── Message grouping ─────────────────────────────────────────────────────────

interface MessageGroup {
  /** True only for messages with role === 'system'. */
  readonly isSystem: boolean;
  readonly messages: Message[];
}

/**
 * Group messages into atomic units:
 *  - Each system message is its own group.
 *  - An assistant message that contains toolCalls, plus all immediately
 *    following tool-result messages, form one group.
 *  - All other messages form their own group.
 */
function buildGroups(messages: readonly Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role === 'system') {
      groups.push({ isSystem: true, messages: [msg] });
      i++;
    } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // Collect this assistant message + all following tool-result messages.
      const unit: Message[] = [msg];
      i++;
      while (i < messages.length && messages[i]!.role === 'tool') {
        unit.push(messages[i]!);
        i++;
      }
      groups.push({ isSystem: false, messages: unit });
    } else {
      groups.push({ isSystem: false, messages: [msg] });
      i++;
    }
  }
  return groups;
}

function flattenGroups(groups: readonly MessageGroup[]): Message[] {
  return groups.flatMap((g) => g.messages);
}

// ─── Strategies ───────────────────────────────────────────────────────────────

function trimOldest(messages: readonly Message[], maxTokens: number): Message[] {
  const groups = buildGroups(messages);
  while (estimateTokens(flattenGroups(groups)) > maxTokens) {
    const idx = groups.findIndex((g) => !g.isSystem);
    if (idx === -1) break; // only system messages remain — nothing more to trim
    groups.splice(idx, 1);
  }
  return flattenGroups(groups);
}

function slidingWindow(messages: readonly Message[], windowSize: number): Message[] {
  const groups = buildGroups(messages);
  const system = groups.filter((g) => g.isSystem);
  const nonSystem = groups.filter((g) => !g.isSystem);
  return flattenGroups([...system, ...nonSystem.slice(-windowSize)]);
}

async function applySummarize(
  messages: readonly Message[],
  memory: AgentMemory,
  ctx: ExecutionContext,
  maxTokens: number,
): Promise<Message[]> {
  // Fall back to trim_oldest when memory can't summarize.
  if (!memory.summarize) return trimOldest(messages, maxTokens);

  const groups = buildGroups(messages);
  const system = groups.filter((g) => g.isSystem);
  const nonSystem = groups.filter((g) => !g.isSystem);

  // Need at least 3 groups to summarize (keep the 2 most recent intact).
  if (nonSystem.length < 3) return trimOldest(messages, maxTokens);

  const summaryText = await memory.summarize(ctx);
  const toKeep = nonSystem.slice(-2);

  return flattenGroups([
    ...system,
    { isSystem: false, messages: [{ role: 'user', content: `[Conversation summary: ${summaryText}]` }] },
    ...toKeep,
  ]);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Apply context management to a message list.
 *
 * Returns a NEW array when compression was applied; returns the SAME reference
 * when the estimated token count is within budget (caller can skip the splice).
 */
export async function applyContextManagement(
  messages: Message[],
  opts: ContextManagementOptions,
  memory?: AgentMemory,
  ctx?: ExecutionContext,
): Promise<Message[]> {
  const maxTokens = opts.maxTokens ?? 100_000;

  // Fast-path: already within budget — return same reference so callers can
  // detect no-op with a reference equality check.
  if (estimateTokens(messages) <= maxTokens) return messages;

  if (opts.strategy === 'sliding_window') {
    return slidingWindow(messages, opts.slidingWindowSize ?? 20);
  }

  if (opts.strategy === 'summarize' && memory && ctx) {
    return applySummarize(messages, memory, ctx, maxTokens);
  }

  // 'trim_oldest' or summarize without a memory.summarize implementation.
  return trimOldest(messages, maxTokens);
}
