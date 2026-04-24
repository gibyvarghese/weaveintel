import type { ExecutionContext } from './context.js';
import type { Tracer } from './observability.js';

let defaultTracer: Tracer | undefined;

function isTracer(value: unknown): value is Tracer {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return typeof obj['startSpan'] === 'function' && typeof obj['withSpan'] === 'function';
}

/**
 * Sets the process-wide tracer fallback used when a context-specific tracer is not provided.
 */
export function setDefaultTracer(tracer: Tracer | undefined): void {
  defaultTracer = tracer;
}

/**
 * Returns the process-wide tracer fallback.
 */
export function getDefaultTracer(): Tracer | undefined {
  return defaultTracer;
}

/**
 * Resolves the effective tracer for an execution.
 * Resolution order: explicit fallback -> ctx.tracer -> ctx.metadata.tracer -> default tracer.
 */
export function resolveTracer(
  ctx: ExecutionContext | undefined,
  fallback?: Tracer,
): Tracer | undefined {
  if (fallback) return fallback;
  if (ctx?.tracer) return ctx.tracer;
  const metadataTracer = ctx?.metadata?.['tracer'];
  if (isTracer(metadataTracer)) return metadataTracer;
  return defaultTracer;
}
