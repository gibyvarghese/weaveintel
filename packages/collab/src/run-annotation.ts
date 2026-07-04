// SPDX-License-Identifier: MIT
/**
 * @weaveintel/collaboration — Run annotations / human feedback scores.
 *
 * An ANNOTATION is a structured quality judgement on a run (or one part of it):
 * a thumbs-up, a 1–5 rating, a rubric category, a free-text note. Unlike a
 * comment (a conversation), an annotation is a SCORE meant to be aggregated and
 * fed into evaluation datasets — the bridge from "a human said this was wrong"
 * to a golden test case.
 *
 * --- For someone new to this ---
 * Think of the 👍/👎 under an AI answer, or a reviewer giving "4 / 5 — helpful".
 * We store each judgement in a consistent shape so they can be counted ("80%
 * thumbs-up"), filtered ("show me only the human ratings, not the auto-grader"),
 * and exported to train/evaluate the system later.
 *
 * Schema (mid-2026 research — the cross-vendor LangSmith/Langfuse/Braintrust/
 * Phoenix core + the OpenTelemetry GenAI `gen_ai.evaluation.*` attributes):
 * `{ name, value, stringValue, comment, source, dataType }` anchored to a run and
 * optionally a single part. Numeric `value` is split from the categorical
 * `stringValue` so booleans/ratings aggregate while labels stay readable; `source`
 * separates HUMAN review from an LLM judge or eval code.
 *
 * Ports & adapters (Phase 0–3 pattern): the {@link AnnotationManager} PORT + an
 * in-memory reference adapter here; a consuming application provides a SQL adapter over
 * `run_annotations`. Both pass {@link annotationManagerContract}.
 */

/** The kind of value a score carries (drives aggregation + rendering). */
export type AnnotationDataType = 'numeric' | 'categorical' | 'boolean' | 'text';

/** Who produced the judgement (so human review filters apart from auto-graders). */
export type AnnotationSource = 'human' | 'llm_judge' | 'eval_code' | 'api' | 'end_user';

export interface RunAnnotation {
  id: string;
  runId: string;
  tenantId: string;
  /** Stable part id this scores (e.g. `tool-3`); '' = the run as a whole. */
  partId: string;
  authorId: string;
  /** Rubric / metric name, e.g. `helpfulness`, `correct`, `thumbs`. */
  name: string;
  dataType: AnnotationDataType;
  /** Numeric value (booleans normalise true→1 / false→0 for aggregation); null for pure text. */
  value: number | null;
  /** Categorical label / text value; null for pure numeric. */
  stringValue: string | null;
  /** Optional free-text justification. */
  comment: string | null;
  source: AnnotationSource;
  createdAt: number;
}

export interface CreateAnnotationInput {
  id: string;
  runId: string;
  tenantId: string;
  authorId: string;
  name: string;
  dataType: AnnotationDataType;
  value?: number | null;
  stringValue?: string | null;
  comment?: string | null;
  /** Defaults to `human`. */
  source?: AnnotationSource;
  /** Defaults to '' (run-level). */
  partId?: string;
}

/** One eval-dataset example derived from an annotation (the "lands in a dataset" bridge). */
export interface EvalExample {
  runId: string;
  partId: string;
  name: string;
  score: number | null;
  label: string | null;
  comment: string | null;
  source: AnnotationSource;
}

export interface AnnotationManager {
  create(input: CreateAnnotationInput): Promise<RunAnnotation>;
  getById(id: string): Promise<RunAnnotation | null>;
  /** All annotations on a run, oldest first. */
  listForRun(runId: string): Promise<RunAnnotation[]>;
  /** Annotations on a specific part. */
  listForPart(runId: string, partId: string): Promise<RunAnnotation[]>;
  /** Delete — AUTHOR ONLY (throws otherwise), unless `{ force: true }` (moderator). */
  delete(id: string, byUserId: string, opts?: { force?: boolean }): Promise<void>;
}

/** Normalise a boolean score to a numeric value (true→1, false→0) for aggregation. */
export function normalizeAnnotationValue(input: Pick<CreateAnnotationInput, 'dataType' | 'value' | 'stringValue'>): { value: number | null; stringValue: string | null } {
  if (input.dataType === 'boolean') {
    const v = input.value !== null && input.value !== undefined ? (input.value ? 1 : 0)
      : input.stringValue === 'true' || input.stringValue === '1' ? 1
      : input.stringValue === 'false' || input.stringValue === '0' ? 0 : null;
    return { value: v, stringValue: v === null ? null : v === 1 ? 'true' : 'false' };
  }
  return { value: input.value ?? null, stringValue: input.stringValue ?? null };
}

/** Aggregate a set of annotations into per-name counts + numeric averages. */
export function summarizeAnnotations(annotations: RunAnnotation[]): Array<{ name: string; count: number; average: number | null }> {
  const byName = new Map<string, RunAnnotation[]>();
  for (const a of annotations) {
    const list = byName.get(a.name) ?? [];
    list.push(a);
    byName.set(a.name, list);
  }
  return [...byName.entries()].map(([name, list]) => {
    const nums = list.map((a) => a.value).filter((v): v is number => typeof v === 'number');
    return { name, count: list.length, average: nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : null };
  });
}

/** Convert annotations to eval-dataset examples (the export-to-dataset bridge). */
export function annotationsToEvalExamples(annotations: RunAnnotation[]): EvalExample[] {
  return annotations.map((a) => ({
    runId: a.runId, partId: a.partId, name: a.name,
    score: a.value, label: a.stringValue, comment: a.comment, source: a.source,
  }));
}

// ─── In-memory reference adapter ────────────────────────────────────────────────

export interface InMemoryAnnotationManagerOptions {
  now?: () => number;
}

export function createInMemoryAnnotationManager(opts: InMemoryAnnotationManagerOptions = {}): AnnotationManager {
  const now = opts.now ?? (() => Date.now());
  const anns = new Map<string, RunAnnotation>();
  return {
    async create(input) {
      const { value, stringValue } = normalizeAnnotationValue(input);
      const ann: RunAnnotation = {
        id: input.id, runId: input.runId, tenantId: input.tenantId,
        partId: input.partId ?? '', authorId: input.authorId,
        name: input.name, dataType: input.dataType, value, stringValue,
        comment: input.comment ?? null, source: input.source ?? 'human', createdAt: now(),
      };
      anns.set(ann.id, ann);
      return ann;
    },
    async getById(id) { return anns.get(id) ?? null; },
    async listForRun(runId) {
      return [...anns.values()].filter((a) => a.runId === runId).sort((a, b) => a.createdAt - b.createdAt);
    },
    async listForPart(runId, partId) {
      return [...anns.values()].filter((a) => a.runId === runId && a.partId === partId).sort((a, b) => a.createdAt - b.createdAt);
    },
    async delete(id, byUserId, opts2) {
      const a = anns.get(id);
      if (!a) return;
      if (a.authorId !== byUserId && !opts2?.force) throw new Error('forbidden: only the author (or a moderator) may delete an annotation');
      anns.delete(id);
    },
  };
}
