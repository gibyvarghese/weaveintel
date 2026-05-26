import type { ExecutionContext } from '@weaveintel/core';
import { weaveResolveTracer } from '@weaveintel/core';

export function toExecutionContextMeta(ctx: ExecutionContext): Record<string, unknown> {
  return {
    executionId: ctx.executionId,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    parentSpanId: ctx.parentSpanId,
    deadline: ctx.deadline,
    budget: ctx.budget,
    metadata: ctx.metadata,
  };
}

export async function withObservedSpan<T>(
  ctx: ExecutionContext,
  name: string,
  attributes: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = weaveResolveTracer(ctx);
  if (!tracer) {
    return fn();
  }
  return tracer.withSpan(ctx, name, () => fn(), attributes);
}
