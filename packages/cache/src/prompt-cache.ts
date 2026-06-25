/**
 * @weaveintel/cache — Provider-native prompt-cache planning (Phase 2).
 *
 * Provider prompt caching (Anthropic explicit `cache_control`, OpenAI/Gemini
 * implicit) discounts the *stable prefix* of a request — the system prompt plus
 * tools plus any few-shot/retrieved context that does not change between turns —
 * at ~90% off input tokens. The win only materialises when (a) the prefix is
 * ordered static-first and identical across requests, and (b) it exceeds the
 * model's minimum cacheable size (≈1,024 tokens on current Claude/GPT models).
 *
 * `planPromptCacheBreakpoints` is the reusable decision: given the size of the
 * stable prefix and a per-model policy, it returns whether to request caching
 * and at which TTL. The app sets `ModelRequest.promptCache = { ttl }` when
 * `enabled` is true; providers that cache implicitly treat it as a no-op.
 */

/** Rough token estimate from character length (~4 chars/token). */
export function estimatePromptTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface PromptCachePlanInput {
  /** The stable system prompt text (system + policy + retrieved context). */
  systemText?: string;
  /** Tool definitions JSON (or any extra stable prefix) contributing to the prefix. */
  toolsText?: string;
  /**
   * Pre-computed estimate of the stable-prefix token count. When provided it
   * overrides the text-length estimate (use a real tokenizer count if available).
   */
  estimatedPrefixTokens?: number;
  /** Minimum cacheable prefix size for the model. Default 1024. */
  minTokens?: number;
  /** Cache TTL to request where supported. Default '5m'. */
  ttl?: '5m' | '1h';
  /** Master enable switch (per-model policy). Default true. */
  enabled?: boolean;
  /**
   * Whether the provider supports/benefits from the hint. Implicit-cache
   * providers (OpenAI/Gemini) still benefit from a stable prefix, but the
   * explicit breakpoint is only meaningful for Anthropic. Default true.
   */
  providerSupported?: boolean;
}

export interface PromptCachePlan {
  /** Whether to request prompt caching (set `ModelRequest.promptCache`). */
  enabled: boolean;
  /** TTL to request. */
  ttl: '5m' | '1h';
  /** Estimated stable-prefix token count used for the decision. */
  estimatedPrefixTokens: number;
  /** The min-tokens threshold applied. */
  minTokens: number;
  /** Human-readable reason (telemetry / debugging). */
  reason: string;
}

/**
 * Decide whether the stable prefix is worth caching and at which TTL.
 *
 * Returns `enabled: false` (with a reason) when caching is disabled by policy,
 * the provider does not support it, or the prefix is below the model minimum —
 * caching a tiny prefix wastes a cache-write with no read benefit.
 */
export function planPromptCacheBreakpoints(input: PromptCachePlanInput): PromptCachePlan {
  const minTokens = input.minTokens ?? 1024;
  const ttl = input.ttl ?? '5m';
  const enabledByPolicy = input.enabled ?? true;
  const providerSupported = input.providerSupported ?? true;

  const estimatedPrefixTokens =
    input.estimatedPrefixTokens ??
    estimatePromptTokens(input.systemText ?? '') + estimatePromptTokens(input.toolsText ?? '');

  if (!enabledByPolicy) {
    return { enabled: false, ttl, estimatedPrefixTokens, minTokens, reason: 'disabled by policy' };
  }
  if (!providerSupported) {
    return { enabled: false, ttl, estimatedPrefixTokens, minTokens, reason: 'provider does not support explicit caching' };
  }
  if (estimatedPrefixTokens < minTokens) {
    return {
      enabled: false,
      ttl,
      estimatedPrefixTokens,
      minTokens,
      reason: `stable prefix ~${estimatedPrefixTokens} tok < min ${minTokens} tok`,
    };
  }
  return {
    enabled: true,
    ttl,
    estimatedPrefixTokens,
    minTokens,
    reason: `stable prefix ~${estimatedPrefixTokens} tok ≥ min ${minTokens} tok`,
  };
}
