/**
 * @weaveintel/guardrails — async-evaluator.ts  (W1)
 *
 * Async evaluation foundation: registry-based dispatch for model-graded and
 * other async guardrail types, with per-guardrail timeout and fail-closed
 * error handling. The existing synchronous `evaluateGuardrail` is unchanged;
 * `evaluateGuardrailAsync` delegates sync types to it immediately.
 *
 * fail-closed semantics:
 *   - A `model-graded` guardrail with `config.on_error: 'deny'` (the default)
 *     that throws or times out resolves to `deny`.
 *   - A purely advisory (`warn`) check that errors resolves to `warn` and
 *     records the error in `metadata.error`.
 *   - Sync types never fail-closed via this path; they use `evaluateGuardrail`.
 */
import type {
  AsyncGuardrailContext,
  Guardrail,
  GuardrailResult,
  GuardrailStage,
} from '@weaveintel/core';
import { evaluateGuardrail } from './guardrail.js';

// ─── Registry ─────────────────────────────────────────────────

export type AsyncGuardrailEvaluatorFn = (
  guardrail: Guardrail,
  input: string,
  ctx: AsyncGuardrailContext,
) => Promise<GuardrailResult>;

export class AsyncEvaluatorRegistry {
  private readonly map = new Map<string, AsyncGuardrailEvaluatorFn>();

  register(name: string, fn: AsyncGuardrailEvaluatorFn): void {
    this.map.set(name, fn);
  }

  get(name: string): AsyncGuardrailEvaluatorFn | undefined {
    return this.map.get(name);
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  /** All registered rule names — useful for debugging/logging. */
  keys(): string[] {
    return [...this.map.keys()];
  }
}

/** Package-level default registry. `evaluators/register.ts` populates this
 *  with all built-in evaluators as a side-effect import. */
export const defaultRegistry = new AsyncEvaluatorRegistry();

// ─── Timeout helper ────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    const result = await Promise.race([promise, timeoutP]);
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── Error result builder ──────────────────────────────────────

function buildErrorResult(
  guardrail: Guardrail,
  onError: 'deny' | 'warn' | 'allow',
  message: string,
): GuardrailResult {
  return {
    decision: onError,
    guardrailId: guardrail.id,
    explanation: `Guardrail error (${guardrail.id}): ${message}`,
    metadata: {
      error: message,
      category: typeof guardrail.config['category'] === 'string' ? guardrail.config['category'] : undefined,
      rule: typeof guardrail.config['rule'] === 'string' ? guardrail.config['rule'] : undefined,
    },
  };
}

// ─── Core async dispatch ───────────────────────────────────────

/**
 * Async-capable guardrail evaluation. Drop-in async counterpart to the sync
 * `evaluateGuardrail`. For `model-graded` guardrails it dispatches through
 * the provided (or default) registry; all other types delegate synchronously.
 *
 * @param guardrail  The guardrail definition.
 * @param input      Raw input value (string or object).
 * @param stage      Pipeline stage for sync-type dispatch.
 * @param context    Evaluation context including optional model references.
 * @param registry   Registry to look up model-graded evaluators (default: `defaultRegistry`).
 */
export async function evaluateGuardrailAsync(
  guardrail: Guardrail,
  input: unknown,
  stage: GuardrailStage,
  context?: AsyncGuardrailContext,
  registry?: AsyncEvaluatorRegistry,
): Promise<GuardrailResult> {
  if (!guardrail.enabled) {
    return { decision: 'allow', guardrailId: guardrail.id, explanation: 'Guardrail disabled' };
  }

  if (guardrail.type === 'model-graded') {
    const ruleName = String(guardrail.config['rule'] ?? guardrail.config['judge'] ?? '');
    const reg = registry ?? defaultRegistry;
    const evaluatorFn = reg.get(ruleName);

    if (evaluatorFn) {
      const timeoutMs =
        typeof guardrail.config['timeout_ms'] === 'number' ? guardrail.config['timeout_ms'] : 5_000;
      const rawOnError = guardrail.config['on_error'];
      const onError: 'deny' | 'warn' | 'allow' =
        rawOnError === 'warn' || rawOnError === 'allow' ? rawOnError : 'deny';
      const text = typeof input === 'string' ? input : JSON.stringify(input);

      try {
        return await withTimeout(evaluatorFn(guardrail, text, context ?? {}), timeoutMs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return buildErrorResult(guardrail, onError, msg);
      }
    }

    // No registered evaluator — preserve the existing placeholder behaviour.
    return {
      decision: 'allow',
      guardrailId: guardrail.id,
      explanation: `model-graded guardrail requires a registered evaluator (rule="${ruleName}")`,
    };
  }

  // All sync types — delegate to the unchanged sync evaluator.
  return evaluateGuardrail(guardrail, input, stage, context);
}
