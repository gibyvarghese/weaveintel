/** Kaggle Submission Validator — agentic + deterministic. */
import type { TaskHandler } from '@weaveintel/live-agents';
import { randomUUID } from 'node:crypto';
import {
  runSubmissionValidation,
  type CvScoresArtifact,
} from '../../../lib/kaggle-validator-runner.js';
import {
  emitToNextAgent,
  loadInboundTask,
  parseInboundJson,
  resolveCreds,
  DEFAULT_MAX_ITERATIONS,
  type SharedHandlerContext,
} from './_shared.js';

/** Agentic mode: rubric-aware validation persisted via runSubmissionValidation.
 *  No-op when no DB is wired. */
export function createValidatorAgentic(ctx: SharedHandlerContext): TaskHandler {
  const { opts, adapter, log } = ctx;
  return async (_a, context) => {
    if (!opts.db) return { completed: true, summaryProse: 'validator: no-op (no db wired)' };
    const inbound = await loadInboundTask(context);
    const parsed = parseInboundJson(inbound?.body);
    const competitionRef =
      (parsed['competitionId'] as string | undefined) ?? (parsed['competitionRef'] as string | undefined);
    if (!competitionRef) return { completed: true, summaryProse: 'validator: no competitionRef in inbound — skipping persistence' };
    const outputFiles = Array.isArray(parsed['outputFiles']) ? (parsed['outputFiles'] as string[]) : [];
    const kernelRef = (parsed['kernelRef'] as string | null | undefined) ?? null;
    const cvScores = (parsed['cvScores'] as CvScoresArtifact | undefined) ?? null;
    const runId = (parsed['runId'] as string | undefined) ?? `kgl-run-${randomUUID().slice(0, 8)}`;
    try {
      const creds = resolveCreds(opts);
      const result = await runSubmissionValidation({
        db: opts.db,
        adapter,
        credentials: creds,
        runId,
        competitionRef,
        tenantId: opts.tenantId ?? null,
        kernelRef,
        outputFiles,
        cvScores,
      });
      log(`validator: verdict=${result.verdict} rubric=${result.rubric.id} violations=${result.violations.length}`);
      return { completed: true, summaryProse: `Validator: ${result.summary}` };
    } catch (err) {
      log(`validator: persistence failed: ${err instanceof Error ? err.message : String(err)}`);
      return { completed: true, summaryProse: 'validator: persistence error (non-fatal)' };
    }
  };
}

/** Deterministic mode: forwards mid-loop feedback to the strategist or
 *  finalizes by emitting to the submitter. Persists when DB is wired. */
export function createValidatorDeterministic(ctx: SharedHandlerContext): TaskHandler {
  const { opts, adapter, log } = ctx;
  return async (_action, context) => {
    const inbound = await loadInboundTask(context);
    if (!inbound) return { completed: true, summaryProse: 'Validator had no inbound payload; skipped.' };

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(inbound.body) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    const iteration = Number(parsed['iteration'] ?? 0);
    const maxIterations = Number(parsed['maxIterations'] ?? DEFAULT_MAX_ITERATIONS);
    const done = parsed['done'] === true;
    const status = (parsed['kernelStatus'] as string) ?? 'unknown';
    const competitionId = (parsed['competitionId'] as string) ?? 'unknown';
    const hasSubmissionFile =
      Array.isArray(parsed['outputFiles']) &&
      (parsed['outputFiles'] as string[]).some((f) => f === 'submission.json' || f === 'submission.csv');

    if (opts.db && competitionId !== 'unknown') {
      const outputFiles = Array.isArray(parsed['outputFiles']) ? (parsed['outputFiles'] as string[]) : [];
      const kernelRef = (parsed['kernelRef'] as string | null | undefined) ?? null;
      const cvScores = (parsed['cvScores'] as CvScoresArtifact | undefined) ?? null;
      const runId = (parsed['runId'] as string | undefined) ?? `kgl-run-${randomUUID().slice(0, 8)}`;
      try {
        const creds = resolveCreds(opts);
        const result = await runSubmissionValidation({
          db: opts.db,
          adapter,
          credentials: creds,
          runId,
          competitionRef: competitionId,
          tenantId: opts.tenantId ?? null,
          kernelRef,
          outputFiles,
          cvScores,
        });
        log(`validator(persist): verdict=${result.verdict} rubric=${result.rubric.id} violations=${result.violations.length}`);
      } catch (err) {
        log(`validator(persist): failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (done || iteration >= maxIterations) {
      await emitToNextAgent(
        context,
        'submitter',
        `Validated final payload for ${competitionId} after ${iteration} iteration(s)`,
        inbound.body,
        'kaggle.validation.final',
      );
      return {
        completed: true,
        summaryProse: `Validator finalized after iteration ${iteration} (status=${status}, submission=${hasSubmissionFile}); forwarded to submitter.`,
      };
    }

    await emitToNextAgent(
      context,
      'strategist',
      `Iteration ${iteration} feedback for ${competitionId}`,
      inbound.body,
      'kaggle.validation.iteration',
    );
    return {
      completed: true,
      summaryProse: `Validator forwarded iteration ${iteration} feedback to strategist (status=${status}, submission=${hasSubmissionFile}).`,
    };
  };
}
