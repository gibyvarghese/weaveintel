/**
 * Smoke test — Phase K7d Kaggle validator pipeline against the live
 * `titanic` competition. Exercises:
 *   1. inferRubricFromCompetition()  (Kaggle metadata → rubric row)
 *   2. ensureRubricForCompetition()  (lookup or auto-persist)
 *   3. runSubmissionValidation()     (schema + distribution + baseline)
 *   4. observeLeaderboardOnce()      (CV→LB delta, percentile)
 *
 * Hits the real Kaggle API for metadata / leaderboard. Does NOT submit.
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { liveKaggleAdapter } from '@weaveintel/tools-kaggle';
import { SQLiteAdapter } from '../apps/geneweave/src/db-sqlite.js';
import { inferRubricFromCompetition } from '../apps/geneweave/src/lib/kaggle-rubric-inference.js';
import {
  ensureRubricForCompetition,
  runSubmissionValidation,
  observeLeaderboardOnce,
} from '../apps/geneweave/src/lib/kaggle-validator-runner.js';

async function main(): Promise<void> {
  const username = process.env['KAGGLE_USERNAME'];
  const key = process.env['KAGGLE_KEY'];
  if (!username || !key) {
    console.error('Missing KAGGLE_USERNAME / KAGGLE_KEY.');
    process.exit(1);
  }
  const credentials = { username, key };
  const competitionRef = 'titanic';
  const tenantId = 'smoke-tenant';
  const runId = `kgl-run-${randomUUID().slice(0, 8)}`;

  const dbPath = '/tmp/titanic-smoke.db';
  // Fresh DB
  const fs = await import('node:fs');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const db = new SQLiteAdapter(dbPath);
  await db.initialize();

  console.log('━━━ Phase K7d smoke test — titanic ━━━\n');
  console.log(`run_id: ${runId}\n`);

  // 1. Direct inference (no DB persist)
  console.log('▸ Step 1 — inferRubricFromCompetition()');
  const inferred = await inferRubricFromCompetition({
    adapter: liveKaggleAdapter,
    credentials,
    competitionRef,
    tenantId,
  });
  console.log('  metric_name      :', inferred.rubric.metric_name);
  console.log('  metric_direction :', inferred.rubric.metric_direction);
  console.log('  baseline_score   :', inferred.rubric.baseline_score);
  console.log('  target_score     :', inferred.rubric.target_score);
  console.log('  inference_source :', inferred.rubric.inference_source);
  if (inferred.warnings.length > 0) console.log('  warnings         :', inferred.warnings);
  console.log();

  // 2. ensureRubric (persists if missing)
  console.log('▸ Step 2 — ensureRubricForCompetition() persists');
  const persisted = await ensureRubricForCompetition({
    db,
    adapter: liveKaggleAdapter,
    credentials,
    competitionRef,
    tenantId,
  });
  console.log('  persisted id     :', persisted.id);
  console.log('  auto_generated   :', persisted.auto_generated);
  console.log();

  // 3. Run validation with synthetic CV scores + submission stats
  console.log('▸ Step 3 — runSubmissionValidation()');
  const cvScores = {
    cv_metric: 'accuracy',
    cv_score: 0.81,
    cv_std: 0.012,
    n_folds: 5,
    baseline_score: persisted.baseline_score ?? 0.6,
  };
  const validation = await runSubmissionValidation({
    db,
    adapter: liveKaggleAdapter,
    credentials,
    runId,
    competitionRef,
    tenantId,
    kernelRef: 'demo-user/titanic-baseline',
    outputFiles: ['submission.csv', 'cv_scores.json'],
    cvScores,
    submissionStats: {
      rowCount: 418,
      columnNames: ['PassengerId', 'Survived'],
      targetDistribution: { '0': 0.62, '1': 0.38 },
    },
  });
  console.log('  verdict          :', validation.verdict);
  console.log('  schema_check     :', validation.schemaCheckPassed);
  console.log('  dist_check       :', validation.distributionCheckPassed);
  console.log('  baseline_check   :', validation.baselineCheckPassed);
  console.log('  summary          :', validation.summary);
  if (validation.violations.length > 0) console.log('  violations       :', validation.violations);
  console.log();

  // 4. Observe leaderboard (no real submission — pass null submission_ref so the
  //    observer takes whatever is first in your account's submissions list, or
  //    skips if none).
  console.log('▸ Step 4 — observeLeaderboardOnce()');
  try {
    const lb = await observeLeaderboardOnce({
      db,
      adapter: liveKaggleAdapter,
      credentials,
      runId,
      competitionRef,
      tenantId,
      submissionRef: null,
      cvScore: cvScores.cv_score,
    });
    if (lb.observed) {
      console.log('  observed         :', lb.observed);
      console.log('  public_score     :', lb.publicScore);
      console.log('  private_score    :', lb.privateScore);
      console.log('  cv_lb_delta      :', lb.cvLbDelta);
      console.log('  raw_status       :', lb.rawStatus);
      console.log('  score_row_id     :', lb.scoreRowId);
    } else {
      console.log('  (no submission to match — skipped)');
    }
  } catch (err) {
    console.log('  observe failed   :', err instanceof Error ? err.message : err);
  }
  console.log();

  // 5. Assert DB rows
  console.log('▸ Step 5 — DB sanity');
  const rubrics = await db.listKaggleCompetitionRubrics({ competitionRef });
  const validations = await db.listKaggleValidationResults({ runId });
  const lbScores = await db.listKaggleLeaderboardScores({ runId });
  console.log('  rubrics rows     :', rubrics.length);
  console.log('  validation rows  :', validations.length);
  console.log('  leaderboard rows :', lbScores.length);

  await db.close();
  console.log('\n✓ titanic smoke test complete');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
