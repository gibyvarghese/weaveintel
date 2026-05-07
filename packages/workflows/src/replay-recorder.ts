/**
 * @weaveintel/workflows — replay-recorder.ts
 *
 * Phase 5 — Workflow replay primitives.
 *
 * Recording a run: wrap any `HandlerResolverRegistry` with
 * `wrapRegistryWithRecorder(registry, recorder)`. Every resolver call
 * captures `(stepId, handler, kind, input, output)` into the recorder.
 *
 * Replaying a run: build a fresh registry whose resolvers return the
 * recorded outputs in order via `createReplayRegistry(trace)`. Run the
 * same workflow definition through the engine; if every step's recorded
 * output matches the recorded output, the trace is deterministic.
 *
 * Designed to live in `@weaveintel/workflows` so the replay package
 * (`@weaveintel/replay`) can wrap workflow runs without depending on
 * engine internals.
 */

import type { HandlerResolver, HandlerResolveContext } from './handler-resolver.js';
import { HandlerResolverRegistry } from './handler-resolver.js';

export interface WorkflowReplayStep {
  /** 0-based ordinal of this resolver invocation. */
  ordinal: number;
  /** Workflow step id (as written in the definition). */
  stepId: string;
  /** Raw `step.handler` string before parsing (may include kind prefix). */
  handler: string;
  /** Resolver `kind` selected (e.g. 'noop', 'tool', 'script'). */
  kind: string;
  /** Step config supplied to the resolver (already projected via inputMap). */
  config: Record<string, unknown>;
  /** Handler input variables at the time of invocation. */
  variables: Record<string, unknown>;
  /** Resolved handler output, JSON-serialised then parsed for stability. */
  output: unknown;
  /** Wall-clock invocation timestamp (epoch ms). */
  recordedAt: number;
}

export interface WorkflowReplayTrace {
  runId: string;
  workflowId: string;
  steps: WorkflowReplayStep[];
}

export class WorkflowReplayRecorder {
  private readonly stepsByRun = new Map<string, WorkflowReplayStep[]>();

  /** Internal — used by the wrapped resolver to append a step record. */
  record(runId: string, step: Omit<WorkflowReplayStep, 'ordinal' | 'recordedAt'>): void {
    let arr = this.stepsByRun.get(runId);
    if (!arr) {
      arr = [];
      this.stepsByRun.set(runId, arr);
    }
    arr.push({ ...step, ordinal: arr.length, recordedAt: Date.now() });
  }

  trace(runId: string, workflowId: string): WorkflowReplayTrace {
    return { runId, workflowId, steps: this.stepsByRun.get(runId) ?? [] };
  }

  reset(runId: string): void {
    this.stepsByRun.delete(runId);
  }
}

function safeClone<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

/**
 * Wrap a HandlerResolverRegistry so every resolver call also writes a
 * `WorkflowReplayStep` to the recorder. Returns a new registry; the input
 * registry is left untouched.
 *
 * IMPORTANT: the engine does not pass `runId` directly to resolvers, so
 * the wrapper requires a `runIdProvider` callback. Apps using this with
 * `DefaultWorkflowEngine` should call `recorder.bind(runId)` immediately
 * before `engine.startRun(...)` and unbind after.
 */
export function wrapRegistryWithRecorder(
  inner: HandlerResolverRegistry,
  recorder: WorkflowReplayRecorder,
  runIdProvider: () => string | null,
): HandlerResolverRegistry {
  const wrapped = new HandlerResolverRegistry();
  for (const orig of inner.list()) {
    const recordingResolver: HandlerResolver = {
      kind: orig.kind,
      ...(orig.description !== undefined ? { description: orig.description } : {}),
      resolve: async (ctx: HandlerResolveContext) => {
        const handler = await orig.resolve(ctx);
        const runId = runIdProvider();
        if (!runId) return handler;
        return async (variables: Record<string, unknown>, config?: Record<string, unknown>) => {
          const output = await handler(variables, config);
          recorder.record(runId, {
            stepId: ctx.step.id,
            handler: ctx.step.handler ?? ctx.step.id,
            kind: orig.kind,
            config: safeClone(config ?? {}),
            variables: safeClone(variables),
            output: safeClone(output),
          });
          return output;
        };
      },
    };
    wrapped.register(recordingResolver);
  }
  return wrapped;
}

/**
 * Build a HandlerResolverRegistry whose every resolver returns the
 * recorded outputs in order. Throws at handler-call time if the replay
 * runs past the recorded steps OR if the step kind / id does not match
 * the trace (deterministic-replay invariant).
 *
 * The cursor is shared across all resolvers so multiple steps that map
 * to the same handler key (e.g. two `'noop'` steps) replay correctly.
 */
export function createReplayRegistry(trace: WorkflowReplayTrace): HandlerResolverRegistry {
  const cursor = { i: 0 };
  const registry = new HandlerResolverRegistry();

  const kinds = new Set(trace.steps.map(s => s.kind));
  for (const kind of kinds) {
    const resolver: HandlerResolver = {
      kind,
      description: `Replay resolver for kind "${kind}" (Phase 5)`,
      resolve: async () => {
        // Cursor read deferred to handler-call time so the same resolved
        // handler instance can be reused across multiple steps that share
        // a handler key (e.g. two 'noop' steps in a row). The engine
        // caches resolved handlers by handler-ref string, so per-step
        // stepId discrimination is not possible in this layer; the
        // replay invariant is *ordinal-strict* — the i-th invocation
        // returns the i-th recorded output. Trace length must equal the
        // run's invocation count or the run fails with `Replay overrun`.
        return async () => {
          const expected = trace.steps[cursor.i];
          if (!expected) {
            throw new Error(
              `Replay overrun: trace exhausted after ${trace.steps.length} steps`,
            );
          }
          cursor.i++;
          return expected.output;
        };
      },
    };
    registry.register(resolver);
  }
  return registry;
}
