/**
 * Phase 7 — Reasoning Effort (lever L7).
 *
 * Wraps any `Model` with a per-call hook that stamps
 * `request.metadata.reasoningEffort` so provider adapters that support
 * reasoning-effort tokens (OpenAI's o-series, Anthropic's extended
 * thinking budget) can forward the value as the appropriate wire field.
 *
 * Mirrors the Phase 3 cache-hint wrapper pattern verbatim. Provider-
 * agnostic: when a provider does not honour the metadata field, the
 * request is forwarded unchanged.
 *
 * Reusability invariant: imports only from `@weaveintel/core` and the
 * cost-governor's own types. NEVER load-bearing — every error path
 * forwards the original request.
 */

import type { ExecutionContext, Model, ModelRequest, ModelResponse, ModelStream } from '@weaveintel/core';

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface WrapModelWithReasoningEffortOptions {
  /** Resolves the per-call effort. Called fresh on every invocation.
   *  Returning `null`/`undefined` skips stamping for that call. */
  readonly resolveEffort: (request: ModelRequest) => ReasoningEffort | null | undefined;
}

/**
 * Wrap a Model so every outgoing request carries
 * `request.metadata.reasoningEffort = <effort>`. Provider adapters opt in
 * by reading this field; providers that ignore it see no behaviour change.
 *
 * If `resolveEffort` returns null/undefined or throws, the request is
 * forwarded unchanged.
 */
export function wrapModelWithReasoningEffort(
  inner: Model,
  opts: WrapModelWithReasoningEffortOptions,
): Model {
  function shape(request: ModelRequest): ModelRequest {
    let effort: ReasoningEffort | null | undefined = null;
    try {
      effort = opts.resolveEffort(request);
    } catch {
      effort = null;
    }
    if (!effort) return request;
    const metadata: Record<string, unknown> = {
      ...(request.metadata ?? {}),
      reasoningEffort: effort,
    };
    return { ...request, metadata };
  }

  const wrapped: Model = {
    info: inner.info,
    capabilities: inner.capabilities,
    hasCapability: inner.hasCapability.bind(inner),
    generate(ctx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
      return inner.generate(ctx, shape(request));
    },
    ...(inner.stream
      ? {
          stream(ctx: ExecutionContext, request: ModelRequest): ModelStream {
            return inner.stream!(ctx, shape(request));
          },
        }
      : {}),
  };
  return wrapped;
}

/** Convenience: wrap with a fixed effort. */
export function wrapModelWithStaticReasoningEffort(inner: Model, effort: ReasoningEffort): Model {
  return wrapModelWithReasoningEffort(inner, { resolveEffort: () => effort });
}
