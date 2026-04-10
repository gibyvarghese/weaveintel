/**
 * @weaveintel/core — Middleware pipeline
 *
 * Why: Cross-cutting concerns (redaction, auth, logging, rate limiting) are
 * composed as middleware, not hardcoded. This keeps each subsystem clean
 * and makes the pipeline data-driven and inspectable.
 */

import type { ExecutionContext } from './context.js';

/**
 * Generic middleware function. Takes a context, a request of type T,
 * and a next function that invokes downstream middleware or the final handler.
 * Returns a response of type R.
 */
export type Middleware<T = unknown, R = unknown> = (
  ctx: ExecutionContext,
  request: T,
  next: (ctx: ExecutionContext, request: T) => Promise<R>,
) => Promise<R>;

/**
 * Compose an array of middleware into a single function.
 * Execution order: first middleware in array wraps the second, etc.
 */
export function composeMiddleware<T, R>(
  middlewares: Middleware<T, R>[],
  handler: (ctx: ExecutionContext, request: T) => Promise<R>,
): (ctx: ExecutionContext, request: T) => Promise<R> {
  if (middlewares.length === 0) return handler;

  return middlewares.reduceRight<(ctx: ExecutionContext, request: T) => Promise<R>>(
    (next, mw) => (ctx, req) => mw(ctx, req, next),
    handler,
  );
}

/**
 * Pipeline builder for ergonomic middleware composition.
 */
export class Pipeline<T, R> {
  private middlewares: Middleware<T, R>[] = [];

  use(mw: Middleware<T, R>): this {
    this.middlewares.push(mw);
    return this;
  }

  build(handler: (ctx: ExecutionContext, request: T) => Promise<R>) {
    return composeMiddleware(this.middlewares, handler);
  }
}

/**
 * Built-in middleware: timeout enforcement.
 */
export function timeoutMiddleware<T, R>(defaultMs: number): Middleware<T, R> {
  return async (ctx, request, next) => {
    const deadline = ctx.deadline ?? Date.now() + defaultMs;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error('Deadline exceeded before execution');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    const combinedSignal = ctx.signal
      ? AbortSignal.any([ctx.signal, controller.signal])
      : controller.signal;

    try {
      return await next({ ...ctx, signal: combinedSignal, deadline }, request);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Built-in middleware: retry with exponential backoff.
 */
export function retryMiddleware<T, R>(opts: {
  maxRetries: number;
  baseDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}): Middleware<T, R> {
  const { maxRetries, baseDelayMs = 1000, shouldRetry } = opts;
  return async (ctx, request, next) => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await next(ctx, request);
      } catch (err) {
        lastError = err;
        if (attempt === maxRetries) break;
        if (shouldRetry && !shouldRetry(err)) break;
        if (ctx.signal?.aborted) break;
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  };
}
