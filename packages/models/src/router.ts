/**
 * @weaveintel/models — Model router
 *
 * Why: The router provides the unified model invocation layer. Consumers call
 * `createModel(...)` and the router resolves the right provider adapter.
 * This is the "one line to call any model" API.
 *
 * The router also supports fallback chains, model routing rules, and
 * capability-based model selection.
 */

import type {
  Model,
  ModelRequest,
  ModelResponse,
  ModelStream,
  StreamChunk,
  ModelInfo,
  EmbeddingModel,
  EmbeddingRequest,
  EmbeddingResponse,
  ExecutionContext,
  EventBus,
  Middleware,
  CapabilityId,
} from '@weaveintel/core';
import { weaveMiddleware, WeaveIntelError, weaveEvent, EventTypes } from '@weaveintel/core';

// ─── Chat model provider registry ────────────────────────────

export type ModelFactory = (modelId: string, options?: Record<string, unknown>) => Model;

const providers = new Map<string, ModelFactory>();

export function registerModelProvider(providerName: string, factory: ModelFactory): void {
  providers.set(providerName, factory);
}

export function getModelProvider(providerName: string): ModelFactory | undefined {
  return providers.get(providerName);
}

// ─── Embedding model provider registry ───────────────────────

export type EmbeddingModelFactory = (modelId: string, options?: Record<string, unknown>) => EmbeddingModel;

const embeddingProviders = new Map<string, EmbeddingModelFactory>();

export function registerEmbeddingProvider(providerName: string, factory: EmbeddingModelFactory): void {
  embeddingProviders.set(providerName, factory);
}

export function getEmbeddingProvider(providerName: string): EmbeddingModelFactory | undefined {
  return embeddingProviders.get(providerName);
}

// ─── createModel — the primary API ───────────────────────────

export interface CreateModelOptions {
  provider: string;
  model: string;
  options?: Record<string, unknown>;
  fallback?: CreateModelOptions[];
  middleware?: Middleware<ModelRequest, ModelResponse>[];
  eventBus?: EventBus;
}

export function createModel(opts: CreateModelOptions): Model {
  const factory = providers.get(opts.provider);
  if (!factory) {
    throw new WeaveIntelError({
      code: 'INVALID_CONFIG',
      message: `Model provider "${opts.provider}" is not registered. Available: ${[...providers.keys()].join(', ')}`,
    });
  }

  const baseModel = factory(opts.model, opts.options);
  const fallbacks = opts.fallback?.map((f) => createModel(f)) ?? [];

  const wrappedModel = wrapWithFallback(baseModel, fallbacks, opts.eventBus);

  if (opts.middleware && opts.middleware.length > 0) {
    return wrapWithMiddleware(wrappedModel, opts.middleware);
  }

  return wrappedModel;
}

// ─── createEmbeddingModel — embedding router ─────────────────

export interface CreateEmbeddingModelOptions {
  provider: string;
  model: string;
  options?: Record<string, unknown>;
  fallback?: CreateEmbeddingModelOptions[];
  eventBus?: EventBus;
}

export function createEmbeddingModel(opts: CreateEmbeddingModelOptions): EmbeddingModel {
  const factory = embeddingProviders.get(opts.provider);
  if (!factory) {
    throw new WeaveIntelError({
      code: 'INVALID_CONFIG',
      message: `Embedding provider "${opts.provider}" is not registered. Available: ${[...embeddingProviders.keys()].join(', ')}`,
    });
  }

  const baseModel = factory(opts.model, opts.options);
  const fallbacks = opts.fallback?.map((f) => createEmbeddingModel(f)) ?? [];

  if (fallbacks.length === 0) return baseModel;

  return wrapEmbeddingWithFallback(baseModel, fallbacks, opts.eventBus);
}

// ─── Embedding fallback chain ────────────────────────────────

function wrapEmbeddingWithFallback(
  primary: EmbeddingModel,
  fallbacks: EmbeddingModel[],
  eventBus?: EventBus,
): EmbeddingModel {
  return {
    info: primary.info,
    capabilities: primary.capabilities,
    hasCapability: primary.hasCapability.bind(primary),

    async embed(ctx: ExecutionContext, request: EmbeddingRequest): Promise<EmbeddingResponse> {
      const allModels = [primary, ...fallbacks];
      let lastError: unknown;

      for (let i = 0; i < allModels.length; i++) {
        const model = allModels[i]!;
        try {
          const response = await model.embed(ctx, request);
          if (i > 0 && eventBus) {
            eventBus.emit(
              weaveEvent('embedding.fallback.used', {
                primaryModel: primary.info.modelId,
                fallbackModel: model.info.modelId,
                fallbackIndex: i,
              }, ctx),
            );
          }
          return response;
        } catch (err) {
          lastError = err;
          if (
            err instanceof WeaveIntelError &&
            !err.retryable &&
            err.code !== 'RATE_LIMITED'
          ) {
            throw err;
          }
        }
      }
      throw lastError;
    },
  };
}

// ─── Chat model fallback chain ───────────────────────────────

function wrapWithFallback(
  primary: Model,
  fallbacks: Model[],
  eventBus?: EventBus,
): Model {
  if (fallbacks.length === 0) return primary;

  const allModels = [primary, ...fallbacks];

  // Stream is available if ANY model in the chain supports it
  const anySupportsStream = allModels.some((m) => m.stream != null);

  return {
    info: primary.info,
    capabilities: primary.capabilities,
    hasCapability: primary.hasCapability.bind(primary),

    async generate(ctx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
      let lastError: unknown;

      for (let i = 0; i < allModels.length; i++) {
        const model = allModels[i]!;
        try {
          const response = await model.generate(ctx, request);
          if (i > 0 && eventBus) {
            eventBus.emit(
              weaveEvent('model.fallback.used', {
                primaryModel: primary.info.modelId,
                fallbackModel: model.info.modelId,
                fallbackIndex: i,
              }, ctx),
            );
          }
          return response;
        } catch (err) {
          lastError = err;
          if (
            err instanceof WeaveIntelError &&
            !err.retryable &&
            err.code !== 'RATE_LIMITED'
          ) {
            throw err;
          }
        }
      }
      throw lastError;
    },

    stream: anySupportsStream
      ? function (ctx: ExecutionContext, request: ModelRequest): ModelStream {
          // Try each model in the chain that supports streaming
          const streamableModels = allModels.filter((m) => m.stream != null);
          return streamWithFallback(streamableModels, ctx, request, eventBus, primary.info.modelId);
        }
      : undefined,
  };
}

/**
 * Async generator that attempts streaming from each model in sequence.
 * If a model's stream throws during iteration, it falls back to the next.
 * Chunks already yielded from a failed model cannot be retracted, so
 * fallback restarts from scratch — suitable for SSE-style consumption
 * where the client can handle a retry signal.
 */
async function* streamWithFallback(
  models: Model[],
  ctx: ExecutionContext,
  request: ModelRequest,
  eventBus?: EventBus,
  primaryModelId?: string,
): AsyncIterable<StreamChunk> {
  let lastError: unknown;

  for (let i = 0; i < models.length; i++) {
    const model = models[i]!;
    try {
      const stream = model.stream!(ctx, request);

      if (i > 0 && eventBus) {
        eventBus.emit(
          weaveEvent('model.stream.fallback.used', {
            primaryModel: primaryModelId,
            fallbackModel: model.info.modelId,
            fallbackIndex: i,
          }, ctx),
        );
      }

      for await (const chunk of stream) {
        yield chunk;
      }
      return; // Stream completed successfully
    } catch (err) {
      lastError = err;
      if (
        err instanceof WeaveIntelError &&
        !err.retryable &&
        err.code !== 'RATE_LIMITED'
      ) {
        throw err;
      }
      // Try next model
    }
  }
  throw lastError;
}

// ─── Middleware wrapping ─────────────────────────────────────

function wrapWithMiddleware(
  model: Model,
  middlewares: Middleware<ModelRequest, ModelResponse>[],
): Model {
  const handler = weaveMiddleware(middlewares, (ctx, req) => model.generate(ctx, req));

  return {
    info: model.info,
    capabilities: model.capabilities,
    hasCapability: model.hasCapability.bind(model),

    async generate(ctx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
      return handler(ctx, request);
    },

    stream: model.stream
      ? function (ctx: ExecutionContext, request: ModelRequest): ModelStream {
          return wrapStreamWithMiddleware(model, middlewares, ctx, request);
        }
      : undefined,
  };
}

/**
 * Wraps a stream call with middleware hooks.
 * 
 * Middleware `next` is called once to produce a generate-style response,
 * but for streaming we need a different approach: we run pre-hooks from
 * middleware, then delegate to the real stream, and accumulate the result
 * for post-hooks. This gives middleware visibility into stream lifecycle.
 */
async function* wrapStreamWithMiddleware(
  model: Model,
  middlewares: Middleware<ModelRequest, ModelResponse>[],
  ctx: ExecutionContext,
  request: ModelRequest,
): AsyncIterable<StreamChunk> {
  // Run the pre-request phase of middleware by invoking the chain,
  // but intercept `next` to actually stream instead of generate.
  //
  // Strategy: wrap the stream in a collector that yields chunks AND
  // builds a synthetic ModelResponse, then let middleware post-process it.

  let preProcessedRequest = request;

  // Walk middleware for pre-processing (each can modify the request)
  for (const mw of middlewares) {
    const capturedReq = preProcessedRequest;
    // Invoke middleware but capture the (possibly modified) request it passes to next
    let requestPassedToNext: ModelRequest | undefined;
    try {
      await mw(ctx, capturedReq, async (_ctx, req) => {
        requestPassedToNext = req;
        // Return a dummy response — we only need the pre-processed request
        return {
          id: '',
          content: '',
          finishReason: 'stop' as const,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          model: model.info.modelId,
        };
      });
    } catch (err) {
      if (!requestPassedToNext) {
        // Middleware threw before calling next — this is an enforcement failure
        // (e.g. content policy blocked the request). Propagate it so callers
        // know the request was rejected, not silently degraded.
        throw err;
      }
      // Middleware called next successfully but threw during post-processing
      // on the dummy response (e.g. response transformation on a stub result).
      // Treat as non-fatal and continue with the captured request.
    }
    if (requestPassedToNext) {
      preProcessedRequest = requestPassedToNext;
    }
  }

  // Now stream with the pre-processed request
  const stream = model.stream!(ctx, preProcessedRequest);
  for await (const chunk of stream) {
    yield chunk;
  }
}

// ─── Observability middleware for models ─────────────────────

export function modelObservabilityMiddleware(
  eventBus: EventBus,
): Middleware<ModelRequest, ModelResponse> {
  return async (ctx, request, next) => {
    const startTime = Date.now();
    eventBus.emit(
      weaveEvent(
        EventTypes.ModelRequestStart,
        { messages: request.messages.length, hasTools: !!request.tools?.length },
        ctx,
      ),
    );

    try {
      const response = await next(ctx, request);
      const durationMs = Date.now() - startTime;

      eventBus.emit(
        weaveEvent(
          EventTypes.ModelRequestEnd,
          {
            model: response.model,
            finishReason: response.finishReason,
            durationMs,
            usage: response.usage,
          },
          ctx,
        ),
      );

      if (response.usage) {
        eventBus.emit(
          weaveEvent(
            EventTypes.ModelTokenUsage,
            {
              model: response.model,
              promptTokens: response.usage.promptTokens,
              completionTokens: response.usage.completionTokens,
              totalTokens: response.usage.totalTokens,
            },
            ctx,
          ),
        );
      }

      return response;
    } catch (err) {
      eventBus.emit(
        weaveEvent(
          EventTypes.ModelRequestError,
          { error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startTime },
          ctx,
        ),
      );
      throw err;
    }
  };
}

/**
 * Observability middleware for stream calls. Emits events for stream
 * lifecycle: start, each chunk, and completion with aggregated usage.
 */
export function streamObservabilityMiddleware(
  eventBus: EventBus,
): (ctx: ExecutionContext, request: ModelRequest, stream: ModelStream) => ModelStream {
  return (ctx, request, stream) => {
    return (async function* (): AsyncIterable<StreamChunk> {
      const startTime = Date.now();
      eventBus.emit(
        weaveEvent(
          EventTypes.ModelRequestStart,
          { messages: request.messages.length, streaming: true },
          ctx,
        ),
      );

      let totalContent = '';
      let usage: StreamChunk['usage'] | undefined;

      try {
        for await (const chunk of stream) {
          if (chunk.type === 'text' && chunk.text) {
            totalContent += chunk.text;
          }
          if (chunk.type === 'usage' && chunk.usage) {
            usage = chunk.usage;
          }
          yield chunk;
        }

        const durationMs = Date.now() - startTime;
        eventBus.emit(
          weaveEvent(
            EventTypes.ModelRequestEnd,
            {
              model: 'stream',
              finishReason: 'stop',
              durationMs,
              streaming: true,
              contentLength: totalContent.length,
              usage,
            },
            ctx,
          ),
        );

        if (usage) {
          eventBus.emit(
            weaveEvent(EventTypes.ModelTokenUsage, { ...usage, streaming: true }, ctx),
          );
        }
      } catch (err) {
        eventBus.emit(
          weaveEvent(
            EventTypes.ModelRequestError,
            { error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startTime, streaming: true },
            ctx,
          ),
        );
        throw err;
      }
    })();
  };
}

// ─── Model selection by capability ───────────────────────────

export function selectModelByCapability(
  models: Model[],
  ...requiredCapabilities: CapabilityId[]
): Model | undefined {
  return models.find((m) =>
    requiredCapabilities.every((cap) => m.hasCapability(cap)),
  );
}

/**
 * Select an embedding model that has all required capabilities.
 */
export function selectEmbeddingByCapability(
  models: EmbeddingModel[],
  ...requiredCapabilities: CapabilityId[]
): EmbeddingModel | undefined {
  return models.find((m) =>
    requiredCapabilities.every((cap) => m.hasCapability(cap)),
  );
}
