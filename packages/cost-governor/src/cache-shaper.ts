/**
 * Phase 3 — Prompt Caching (lever L2) shaper.
 *
 * Real implementation of the prompt-caching lever. Operates as a thin,
 * reusable, provider-agnostic layer:
 *
 *   1. `weavePromptCachingShaper(config)` returns a stateless `CacheShaper`
 *      that computes a stable `prompt_cache_key` per call from the supplied
 *      context and the operator-configured `keyStrategy`.
 *
 *   2. `wrapModelWithCacheHints(inner, shaper, ctxResolver)` wraps any
 *      `Model` (OpenAI, Anthropic, Bedrock, custom) with a per-call hook
 *      that:
 *        - calls `shaper.compute(ctx)` to get hints,
 *        - merges them into `request.metadata` in a provider-agnostic way,
 *        - rewrites the system message into Anthropic content blocks with
 *          `cache_control: { type: 'ephemeral' }` when the inner model is
 *          Anthropic — so the static prefix is actually cached on the wire,
 *        - tags `request.metadata.promptCacheKey` so the OpenAI provider
 *          (which now reads this field) injects `prompt_cache_key`.
 *
 * The wrapper is purely additive — if the shaper returns `null` (caching
 * disabled / no hint computable), the request is forwarded unchanged.
 *
 * Reusability: this module imports only from `@weaveintel/core`. It does
 * not import from any provider package, app code, or DB adapter. Any
 * consumer that holds a `Model` can wrap it.
 */

import type {
  ExecutionContext,
  Message,
  Model,
  ModelRequest,
  ModelResponse,
  ModelStream,
} from '@weaveintel/core';
import type { PromptCachingConfig } from './policy.js';

// ─── Provider-agnostic hint shape ─────────────────────────────

/**
 * Per-call cache hints produced by a `CacheShaper`. Provider adapters
 * (OpenAI, Anthropic, etc.) translate these into wire-level fields.
 */
export interface PromptCacheHints {
  /** Stable cache lane key (≤ 64 chars, ASCII). */
  readonly cacheKey: string;
  /**
   * When true, the wrapper SHOULD mark the system prompt as the cacheable
   * prefix for providers that require explicit markers (Anthropic).
   * For providers that auto-detect prefixes (OpenAI), this is informational.
   */
  readonly markSystemAsCacheable: boolean;
  /** TTL hint passed through to providers that accept it (Anthropic). */
  readonly ttl?: '5m' | '1h';
}

/** Per-call context passed to the shaper. Consumers fill in what they have. */
export interface CacheShapeContext {
  /** Lower-case provider id. e.g. 'openai' | 'anthropic' | 'azure-openai'. */
  readonly provider: string;
  /** Free-form role tag — e.g. 'strategist' | 'validator' | 'chat'. */
  readonly role?: string;
  /** Free-form phase tag — e.g. 'discovery' | 'kernel' | 'submit'. */
  readonly phase?: string;
  readonly modelId?: string;
  readonly tenantId?: string;
  readonly meshId?: string;
  readonly agentId?: string;
  /**
   * Optional caller-supplied version stamp. When the prompt's static prefix
   * changes (e.g. playbook revision bumps) callers SHOULD bump this so
   * the cache lane rotates and stale entries are not silently reused.
   */
  readonly version?: string;
}

/** Provider-agnostic shaper interface. */
export interface CacheShaper {
  /** Returns hints for this call, or `null` when caching is disabled. */
  compute(ctx: CacheShapeContext): PromptCacheHints | null;
}

// ─── Built-in shapers ─────────────────────────────────────────

export const noopCacheShaper: CacheShaper = {
  compute: () => null,
};

/**
 * Real prompt-caching shaper. Stateless. Honours `config.enabled` and
 * `config.keyStrategy` from the merged `ResolvedCostPolicy.promptCaching`.
 *
 *   keyStrategy = 'static'        → cacheKey = "static:v{version|'1'}"
 *   keyStrategy = 'role'          → cacheKey = "role:{role|'default'}:v{version|'1'}"
 *   keyStrategy = 'role+phase'    → cacheKey = "role:{role}:phase:{phase}:v{version}"
 *
 * The key is sanitised (ASCII, ≤ 64 chars) so it is safe to forward to
 * provider APIs that constrain the field (OpenAI: ≤ 64 ASCII chars).
 */
export function weavePromptCachingShaper(config: PromptCachingConfig): CacheShaper {
  if (!config.enabled) return noopCacheShaper;
  const strategy = config.keyStrategy ?? 'role';

  return {
    compute(ctx: CacheShapeContext): PromptCacheHints | null {
      const version = ctx.version ?? '1';
      let key: string;
      switch (strategy) {
        case 'static':
          key = `static:v${version}`;
          break;
        case 'role+phase':
          key = `role:${ctx.role ?? 'default'}:phase:${ctx.phase ?? 'default'}:v${version}`;
          break;
        case 'role':
        default:
          key = `role:${ctx.role ?? 'default'}:v${version}`;
          break;
      }
      return {
        cacheKey: sanitiseCacheKey(key),
        markSystemAsCacheable: true,
      };
    },
  };
}

function sanitiseCacheKey(raw: string): string {
  // Keep ASCII alnum + '_' '-' ':' '.', collapse anything else.
  const cleaned = raw.replace(/[^a-zA-Z0-9_\-:.]/g, '_');
  return cleaned.length <= 64 ? cleaned : cleaned.slice(0, 64);
}

// ─── Model wrapper (provider-aware) ───────────────────────────

export interface WrapModelWithCacheHintsOptions {
  /** Resolves the per-call context. Called fresh on every invocation. */
  readonly resolveContext: () => CacheShapeContext | null | undefined;
}

/**
 * Wraps any `Model` with a per-call hook that injects prompt-caching hints
 * into the outgoing `ModelRequest`. Provider-aware:
 *
 *   - If `inner.info.provider === 'anthropic'`, rewrites the system message
 *     into a content-block array with `cache_control: ephemeral` on the
 *     trailing block (per Anthropic's prefix-cache rules).
 *   - Otherwise (OpenAI / Azure / generic): tags
 *     `request.metadata.promptCacheKey` and lets the provider adapter
 *     translate to its wire field (the OpenAI adapter forwards this as
 *     `prompt_cache_key`).
 *
 * If `shaper.compute()` returns `null`, the request is forwarded unchanged.
 */
export function wrapModelWithCacheHints(
  inner: Model,
  shaper: CacheShaper,
  opts: WrapModelWithCacheHintsOptions,
): Model {
  const provider = inner.info.provider;

  function shape(request: ModelRequest): ModelRequest {
    const ctx = opts.resolveContext() ?? null;
    if (!ctx) return request;
    let hints: PromptCacheHints | null = null;
    try {
      hints = shaper.compute(ctx);
    } catch {
      hints = null;
    }
    if (!hints) return request;

    // Provider-agnostic: stamp the cache key into metadata so any provider
    // that knows about it (OpenAI today; Bedrock + Vertex tomorrow) picks
    // it up without further changes.
    const metadata: Record<string, unknown> = {
      ...(request.metadata ?? {}),
      promptCacheKey: hints.cacheKey,
    };

    let messages: ReadonlyArray<Message> = request.messages;

    // Anthropic-specific: emit the system content as a single
    // content-block array with cache_control. Without explicit markers,
    // Anthropic does NOT cache the prefix.
    if (provider === 'anthropic' && hints.markSystemAsCacheable) {
      const systemMsg = request.messages.find((m) => m.role === 'system');
      if (systemMsg && typeof systemMsg.content === 'string' && systemMsg.content.trim().length > 0) {
        const cacheControl = hints.ttl
          ? { type: 'ephemeral' as const, ttl: hints.ttl }
          : { type: 'ephemeral' as const };
        const block = {
          type: 'text',
          text: systemMsg.content,
          cache_control: cacheControl,
        };
        // Anthropic provider reads `metadata.systemPrompt` (content-block
        // array) and uses it INSTEAD of any system message in `messages`.
        metadata['systemPrompt'] = [block];
        // Drop the system role from the messages array so it isn't
        // double-counted (Anthropic provider already extracts it
        // top-level, but we want only the content-block path to win).
        messages = request.messages.filter((m) => m.role !== 'system');
      }
    }

    return {
      ...request,
      messages,
      metadata,
    };
  }

  const wrapped: Model = {
    info: inner.info,
    capabilities: inner.capabilities,
    hasCapability: (id) => inner.hasCapability(id),
    async generate(execCtx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
      return inner.generate(execCtx, shape(request));
    },
  };

  if (typeof inner.stream === 'function') {
    wrapped.stream = function (execCtx: ExecutionContext, request: ModelRequest): ModelStream {
      return inner.stream!(execCtx, shape(request));
    };
  }

  return wrapped;
}
