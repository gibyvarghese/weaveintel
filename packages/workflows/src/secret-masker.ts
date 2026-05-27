/**
 * @weaveintel/workflows — secret-masker.ts
 *
 * Phase W3 — Secret masking for step outputs, run state, and checkpoint payloads.
 *
 * Fields listed in `step.maskFields` are replaced with `"***"` before the
 * step output is written to `state.variables`, checkpoints, or event payloads.
 * Dot-notation paths (e.g. `"auth.token"`) drill into nested objects.
 */

/**
 * Replace named field paths in `value` with `"***"`.
 * Supports dot-notation for arbitrary nesting depth.
 * Arrays are traversed element-wise; other primitives are returned as-is.
 */
export function maskValue(value: unknown, paths: string[]): unknown {
  if (!paths.length) return value;
  return applyMask(value, paths.map(p => p.split('.')));
}

function applyMask(value: unknown, segments: string[][]): unknown {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map(item => applyMask(item, segments));
  }

  const obj = { ...(value as Record<string, unknown>) };
  for (const parts of segments) {
    maskPath(obj, parts, 0);
  }
  return obj;
}

function maskPath(obj: Record<string, unknown>, parts: string[], depth: number): void {
  if (depth >= parts.length) return;
  const key = parts[depth]!;
  if (!(key in obj)) return;

  if (depth === parts.length - 1) {
    obj[key] = '***';
    return;
  }

  const child = obj[key];
  if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
    const copy = { ...(child as Record<string, unknown>) };
    maskPath(copy, parts, depth + 1);
    obj[key] = copy;
  }
}

/**
 * Mask the `__step_<stepId>` variable written to `state.variables` after a
 * step completes. Called by the engine before `advanceState()`.
 */
export function maskStepOutput(output: unknown, maskFields: string[]): unknown {
  if (!maskFields.length) return output;
  return maskValue(output, maskFields);
}
