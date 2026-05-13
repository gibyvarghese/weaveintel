/**
 * Model wrapper that intercepts `generate` and `stream` calls, extracts the
 * provider-supplied `usage` block, computes USD via a `PricingResolver`,
 * and forwards a `CostLedgerEntry` to a sink. Strictly observational —
 * any failure inside the cost path is swallowed.
 */

import type {
  ExecutionContext,
  Model,
  ModelRequest,
  ModelResponse,
  ModelStream,
  StreamChunk,
} from '@weaveintel/core';
import type {
  CostLedgerEntry,
  CostLedgerSink,
  ModelUsageObservation,
  PricingResolver,
} from './types.js';
import { computeUsd } from './types.js';

export interface ModelCostContext {
  /** Run id (mandatory — entries with no run cannot be aggregated). */
  runId: string;
  stepId?: string;
  agentId?: string;
  agentRole?: string;
}

export interface WrapModelOptions {
  sink: CostLedgerSink;
  pricing: PricingResolver;
  newId: () => string;
  /** Resolves the per-call cost context. Called fresh on every invocation. */
  resolveContext: () => ModelCostContext | null | undefined;
  /** Optional per-entry tag (e.g. "agentic.react"). */
  source?: string;
}

/**
 * Returns a new Model that delegates to `inner` and emits a single cost
 * entry per generate / per completed stream. The `usage` block is the only
 * thing read; if the provider omits it, the entry records zero tokens
 * and zero USD (still useful as a "model invoked" marker).
 */
export function wrapModelWithCostLedger(inner: Model, opts: WrapModelOptions): Model {
  const { sink, pricing, newId, resolveContext } = opts;

  async function emit(usage: ModelUsageObservation): Promise<void> {
    const ctx = resolveContext();
    if (!ctx || !ctx.runId) return;
    let rate: Awaited<ReturnType<PricingResolver['resolve']>> = null;
    try {
      rate = await pricing.resolve(usage.modelId);
    } catch {
      rate = null;
    }
    const costUsd = computeUsd(usage, rate);
    const entry: CostLedgerEntry = {
      id: newId(),
      runId: ctx.runId,
      ...(ctx.stepId    !== undefined ? { stepId: ctx.stepId       } : {}),
      ...(ctx.agentId   !== undefined ? { agentId: ctx.agentId     } : {}),
      ...(ctx.agentRole !== undefined ? { agentRole: ctx.agentRole } : {}),
      source: 'model',
      lever: (usage.reasoningTokens ?? 0) > 0 ? 'reasoning' : 'model',
      subject: usage.modelId,
      ...(usage.provider !== undefined ? { provider: usage.provider } : {}),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cachedTokens    !== undefined ? { cachedTokens: usage.cachedTokens       } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      costUsd,
      observedAt: Date.now(),
      ...(opts.source ? { metadata: { source: opts.source } } : {}),
    };
    try {
      await sink.append(entry);
    } catch {
      /* sink failures must never break the model call */
    }
  }

  const wrapped: Model = {
    info: inner.info,
    capabilities: inner.capabilities,
    hasCapability: (id) => inner.hasCapability(id),
    async generate(execCtx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
      const res = await inner.generate(execCtx, request);
      try {
        await emit({
          modelId: res.model ?? inner.info.modelId,
          provider: inner.info.provider,
          inputTokens: res.usage?.promptTokens ?? 0,
          outputTokens: res.usage?.completionTokens ?? 0,
          ...(res.usage?.reasoningTokens !== undefined ? { reasoningTokens: res.usage.reasoningTokens } : {}),
        });
      } catch {/* swallow */}
      return res;
    },
  };

  if (typeof inner.stream === 'function') {
    wrapped.stream = function (execCtx: ExecutionContext, request: ModelRequest): ModelStream {
      const innerStream = inner.stream!(execCtx, request);
      return wrapStream(innerStream, inner, emit);
    };
  }

  return wrapped;
}

async function* wrapStream(
  source: ModelStream,
  inner: Model,
  emit: (usage: ModelUsageObservation) => Promise<void>,
): AsyncIterable<StreamChunk> {
  let lastUsage: ModelUsageObservation | null = null;
  for await (const chunk of source) {
    if (chunk.type === 'usage' && chunk.usage) {
      lastUsage = {
        modelId: inner.info.modelId,
        provider: inner.info.provider,
        inputTokens: chunk.usage.promptTokens,
        outputTokens: chunk.usage.completionTokens,
        ...(chunk.usage.reasoningTokens !== undefined ? { reasoningTokens: chunk.usage.reasoningTokens } : {}),
      };
    }
    yield chunk;
  }
  if (lastUsage) {
    try { await emit(lastUsage); } catch {/* swallow */}
  }
}
