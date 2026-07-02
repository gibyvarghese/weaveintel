/**
 * @weaveintel/collaboration — Answer variants (regenerate with version history).
 *
 * When a reader regenerates an assistant answer, the old answer must NOT be thrown away — it becomes one
 * VERSION among several, and the reader can page between them ("‹ 2/3 ›"), exactly like ChatGPT/Claude.
 * This module is the pure, reusable model of that "stack of variants with an active pointer": add a new
 * variant, select one, ask which is active, and render the "2/3" label. It does NO I/O (the app persists the
 * variants + calls the model), so it is trivially unit-testable and shared by the API route, the service,
 * and the UI.
 *
 * Research grounding (2026 practice):
 *  - Regenerate is destructive in naive implementations (the new answer overwrites the old). Every mature
 *    assistant keeps the prior answers as siblings of the same question and lets you switch back — losing an
 *    answer you preferred is a well-known frustration. So variants are APPEND-ONLY and switching is lossless.
 *  - A workspace will not keep unbounded history per turn; a `maxKept` bound prunes the OLDEST variants but
 *    never the one currently shown (you can't prune the answer the reader is looking at).
 *
 * Everything here is PURE (no I/O).
 */

/** One generated answer for a single question turn. */
export interface AnswerVariant {
  /** Stable id for this variant (e.g. a message/variant row id). */
  id: string;
  content: string;
  /** What produced it — for the "regenerated with gpt-4o-mini" affordance + audit. */
  model?: string | null;
  provider?: string | null;
  /** Why this variant exists: 'original' | 'regenerate' | 'shorter' | 'different_model' | free text. */
  reason?: string | null;
  /** ISO timestamp (the app stamps it; kept optional so the model stays pure/deterministic). */
  createdAt?: string | null;
}

/** A stack of variants for ONE question turn, with a pointer to the one currently shown. */
export interface VariantStack {
  variants: AnswerVariant[];
  /** Index of the active (shown) variant. Always a valid index when `variants` is non-empty. */
  activeIndex: number;
}

/** Default ceiling on how many variants to keep per turn (oldest pruned first, never the active one). */
export const DEFAULT_MAX_VARIANTS = 5;

function clampIndex(i: number, len: number): number {
  if (len <= 0) return 0;
  if (!Number.isFinite(i)) return 0;
  return Math.max(0, Math.min(len - 1, Math.floor(i)));
}

/** Build a stack from an ordered variant list (index 0 = oldest). The newest is active by default. */
export function makeVariantStack(variants: AnswerVariant[], activeIndex?: number): VariantStack {
  const v = Array.isArray(variants) ? variants.slice() : [];
  const active = activeIndex === undefined ? v.length - 1 : clampIndex(activeIndex, v.length);
  return { variants: v, activeIndex: v.length ? active : 0 };
}

/**
 * Append a new variant (the just-generated answer) and make it active. If adding it exceeds `maxKept`, prune
 * the OLDEST variants — but never drop the one that ends up active. Returns a new stack (no mutation).
 */
export function addVariant(stack: VariantStack, variant: AnswerVariant, maxKept = DEFAULT_MAX_VARIANTS): VariantStack {
  const list = [...stack.variants, variant];
  const cap = Math.max(1, Math.floor(maxKept));
  if (list.length <= cap) return { variants: list, activeIndex: list.length - 1 };
  // Prune from the front (oldest), keeping the last `cap` — the new variant (active) is always among them.
  const pruned = list.slice(list.length - cap);
  return { variants: pruned, activeIndex: pruned.length - 1 };
}

/** Switch the active variant. An out-of-range index is clamped (never throws). */
export function selectVariant(stack: VariantStack, index: number): VariantStack {
  return { variants: stack.variants, activeIndex: clampIndex(index, stack.variants.length) };
}

/** The active variant, or null when the stack is empty. */
export function activeVariant(stack: VariantStack): AnswerVariant | null {
  return stack.variants[stack.activeIndex] ?? null;
}

/** The pager label for the UI: 1-based position, total, and a "2/3" string. total<=1 → show:false. */
export function variantLabel(stack: VariantStack): { index: number; total: number; text: string; show: boolean; canPrev: boolean; canNext: boolean } {
  const total = stack.variants.length;
  const index = total ? stack.activeIndex + 1 : 0;
  return {
    index, total, text: `${index}/${total}`,
    show: total > 1,
    canPrev: stack.activeIndex > 0,
    canNext: stack.activeIndex < total - 1,
  };
}
