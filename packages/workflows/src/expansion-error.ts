/**
 * @weaveintel/workflows — expansion-error.ts
 *
 * ─── Phase W7 — Dynamic Graph ───────────────────────────────────────────────
 *
 * Thrown by `validateExpansion` when a runtime-generated sub-graph fails
 * any governance check. The run is marked `failed` with `error` set to the
 * full error message (including the code prefix) so callers can distinguish
 * expansion rejections from ordinary step failures.
 */

export type WorkflowExpansionErrorCode =
  | 'MAX_EXPANSION_DEPTH'
  | 'MAX_GENERATED_STEPS'
  | 'ID_COLLISION'
  | 'RESERVED_KEY'
  | 'INVALID_ENTRY'
  | 'DISALLOWED_HANDLER_KIND'
  | 'LINT_ERROR'
  | 'INVALID_EXPANSION';

/**
 * Phase W7 — Thrown when a `dynamic` step's expansion fails governance
 * validation. The `code` field identifies which rule was violated so
 * catch-handlers can react without string-matching the message.
 */
export class WorkflowExpansionError extends Error {
  readonly code: WorkflowExpansionErrorCode;

  constructor(code: WorkflowExpansionErrorCode, detail: string) {
    super(`WorkflowExpansionError [${code}]: ${detail}`);
    this.name = 'WorkflowExpansionError';
    this.code = code;
  }
}
