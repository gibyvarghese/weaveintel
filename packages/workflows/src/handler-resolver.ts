/**
 * @weaveintel/workflows — handler-resolver.ts
 *
 * The HandlerResolver contract turns a string `step.handler` reference
 * (e.g. `'tool:web.search'`, `'prompt:summarize@v3'`, `'agent:planner'`,
 * `'mcp:gmail:listMessages'`, `'script:slug'`, `'subworkflow:wf-key'`,
 * `'noop'`) into a runnable `StepHandler` at run-start time.
 *
 * Each resolver claims a `kind` prefix (the part before the first `:`).
 * The engine consults the registry only when a step's handler key is
 * missing from its in-process `StepHandlerMap`. This preserves full
 * backward compatibility with `engine.registerHandler('foo', fn)`.
 *
 * Resolvers are *async* because most resolvers will read from a DB,
 * a remote registry, or an MCP server before producing the handler.
 */
import type { WorkflowStep } from '@weaveintel/core';
import type { StepHandler } from './steps.js';

export interface HandlerResolveContext {
  workflowId: string;
  stepId: string;
  /** The portion of the handler string after the first `:`. */
  ref: string;
  /** Resolved step config (already merged with any defaults). */
  config: Record<string, unknown>;
  /** Caller-provided dependencies bag (tool registry, prompt store, etc.). */
  deps?: Record<string, unknown> | undefined;
  /** The full step record for advanced resolvers that need more context. */
  step: WorkflowStep;
}

export interface HandlerResolver {
  /** Lower-case kind claimed by this resolver, e.g. `'tool'`, `'prompt'`. */
  readonly kind: string;
  /**
   * Optional human-friendly description shown in admin UIs / handler-kind
   * registry sync. Operators see this when picking a handler kind.
   */
  readonly description?: string;
  /**
   * Optional JSON Schema (draft-07 subset) describing the `step.config`
   * shape this resolver expects. Surfaced to admin UIs for form generation.
   */
  readonly configSchema?: Record<string, unknown>;
  /**
   * Build a runnable StepHandler for the given handler reference. May be
   * called once per run-start. The returned handler will be cached for the
   * duration of the run.
   */
  resolve(ctx: HandlerResolveContext): Promise<StepHandler>;
}

/**
 * Registry of handler resolvers indexed by `kind` prefix.
 * Last-registered wins for the same kind.
 */
export class HandlerResolverRegistry {
  private readonly resolvers = new Map<string, HandlerResolver>();

  register(resolver: HandlerResolver): void {
    this.resolvers.set(resolver.kind, resolver);
  }

  registerMany(resolvers: readonly HandlerResolver[]): void {
    for (const r of resolvers) this.register(r);
  }

  /** Look up by exact kind. */
  get(kind: string): HandlerResolver | undefined {
    return this.resolvers.get(kind);
  }

  /**
   * Look up by handler reference. Splits on the first `:`. A bare reference
   * with no `:` (e.g. `'noop'`) is treated as `kind=ref` with empty `ref`.
   */
  forHandler(handlerRef: string): { resolver: HandlerResolver; ref: string } | undefined {
    const colonAt = handlerRef.indexOf(':');
    const kind = colonAt < 0 ? handlerRef : handlerRef.slice(0, colonAt);
    const ref = colonAt < 0 ? '' : handlerRef.slice(colonAt + 1);
    const resolver = this.resolvers.get(kind);
    if (!resolver) return undefined;
    return { resolver, ref };
  }

  /** Return all registered resolvers in registration order. */
  list(): HandlerResolver[] {
    return [...this.resolvers.values()];
  }
}

export function createHandlerResolverRegistry(
  resolvers?: readonly HandlerResolver[],
): HandlerResolverRegistry {
  const reg = new HandlerResolverRegistry();
  if (resolvers?.length) reg.registerMany(resolvers);
  return reg;
}
