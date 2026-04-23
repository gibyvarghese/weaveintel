/**
 * Example 62 — Phase 7 Observability, Replay, and Eval Persistence E2E
 *
 * This example demonstrates how to persist three Phase-7 runtime artefact families
 * using the same backend-switching strategy introduced in earlier phases:
 * - observability trace spans
 * - replay checkpoints
 * - evaluation suite run metadata
 *
 * Run:
 *   node --import tsx examples/62-phase7-observability-replay-eval-persistence-e2e.ts
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { weaveContext } from '@weaveintel/core';
import { weaveInMemoryTracer } from '@weaveintel/observability';
import { createReplayEngine } from '@weaveintel/replay';
import { weaveEvalRunner } from '@weaveintel/evals';
import {
  createPhase7RuntimePersistence,
  type Phase7RuntimePersistence,
} from '@weaveintel/persistence';

const POSTGRES_URL = process.env['WEAVE_PHASE7_EXAMPLE_POSTGRES_URL'];
const REDIS_URL = process.env['WEAVE_PHASE7_EXAMPLE_REDIS_URL'];
const SQLITE_PATH = process.env['WEAVE_PHASE7_EXAMPLE_SQLITE_PATH'];
const MONGODB_URL = process.env['WEAVE_PHASE7_EXAMPLE_MONGODB_URL'];
const DYNAMODB_ENDPOINT = process.env['WEAVE_PHASE7_EXAMPLE_DYNAMODB_ENDPOINT'];
const DYNAMODB_REGION = process.env['WEAVE_PHASE7_EXAMPLE_DYNAMODB_REGION'] ?? 'us-east-1';
const DYNAMODB_TABLE = process.env['WEAVE_PHASE7_EXAMPLE_DYNAMODB_TABLE'] ?? 'weave_phase7_runtime';

async function runPhase7Scenario(label: string, persistence: Phase7RuntimePersistence): Promise<void> {
  const ctx = weaveContext({
    tenantId: `phase7-${label}-tenant`,
    userId: `phase7-${label}-user`,
    metadata: { sessionId: `phase7-${label}-session` },
  });

  // 1) Produce spans via the observability package and persist them.
  // This demonstrates telemetry parity: trace artefacts now survive process restarts.
  const tracer = weaveInMemoryTracer();
  await tracer.withSpan(ctx, `${label}:root-span`, async () => {
    return Promise.resolve();
  });
  for (const span of tracer.spans) {
    await persistence.saveTraceSpan(ctx, {
      executionId: ctx.executionId,
      traceId: span.traceId,
      span,
      metadata: { source: 'example-62' },
    });
  }

  // 2) Produce a replay result and persist a replay checkpoint reference.
  // We attach replay status/match metadata so operators can inspect replay health.
  const replay = createReplayEngine();
  const replayResult = await replay.replay(ctx, {
    executionId: ctx.executionId,
    startTime: Date.now() - 20,
    endTime: Date.now(),
    status: 'completed',
    totalTokens: 2,
    totalCostUsd: 0,
    steps: [
      {
        index: 0,
        type: 'model',
        name: 'echo-step',
        startTime: Date.now() - 10,
        endTime: Date.now() - 5,
        input: { messages: [{ role: 'user', content: `${label} hello` }] },
        output: { output: `${label} hello` },
      },
    ],
  });
  await persistence.saveReplayCheckpoint(ctx, {
    runId: `${label}-run`,
    checkpoint: {
      id: `${label}-checkpoint`,
      runId: `${label}-run`,
      workflowId: 'phase7-example-workflow',
      stepId: 'replay-eval-step',
      createdAt: new Date().toISOString(),
      state: {
        currentStepId: 'replay-eval-step',
        variables: { replayMatchRate: replayResult.matchRate },
        history: [],
      },
    },
    metadata: {
      replayStatus: replayResult.status,
      replayMatchRate: replayResult.matchRate,
    },
  });

  // 3) Run an eval suite and persist eval metadata.
  // This keeps both aggregate score and case-level details available for auditing.
  const evalRunner = weaveEvalRunner({
    async executor(_execCtx, input) {
      return { output: String(input['prompt'] ?? '') };
    },
  });
  const evalResult = await evalRunner.run(
    ctx,
    {
      name: `${label}-eval-suite`,
      type: 'agent',
      assertions: [
        {
          name: 'contains-label',
          type: 'contains',
          config: { substring: label },
        },
      ],
    },
    [
      {
        id: `${label}-case-1`,
        input: { prompt: `${label} persisted` },
      },
    ],
  );
  await persistence.saveEvalSuiteRun(ctx, {
    executionId: ctx.executionId,
    evalName: evalResult.name,
    result: evalResult,
    metadata: { source: 'example-62' },
  });

  // 4) Verify persisted artefacts for this execution.
  // These assertions are intentionally strict because this file is an E2E smoke test.
  const spans = await persistence.listTraceSpans(ctx, { executionId: ctx.executionId });
  const checkpoint = await persistence.loadLatestReplayCheckpoint(ctx, `${label}-run`);
  const evalRuns = await persistence.listEvalSuiteRuns(ctx, { executionId: ctx.executionId });

  if (spans.length === 0) {
    throw new Error(`${label} expected persisted spans`);
  }
  if (!checkpoint) {
    throw new Error(`${label} expected persisted replay checkpoint`);
  }
  if (evalRuns.length === 0) {
    throw new Error(`${label} expected persisted eval runs`);
  }

  console.log(`  ✓ ${label} persisted spans=${spans.length} checkpoint=${checkpoint.id} evalRuns=${evalRuns.length}`);
}

async function main(): Promise<void> {
  console.log('Phase 7 observability/replay/eval persistence E2E');

  console.log('\n[1/6] in-memory');
  await runPhase7Scenario('memory', createPhase7RuntimePersistence({ backend: 'in-memory' }));

  if (POSTGRES_URL) {
    console.log('\n[2/6] postgres');
    const persistence = createPhase7RuntimePersistence({ backend: 'postgres', postgresUrl: POSTGRES_URL });
    await runPhase7Scenario('postgres', persistence);
    await persistence.close();
  } else {
    console.log('\n[2/6] postgres');
    console.log('  - skipped (WEAVE_PHASE7_EXAMPLE_POSTGRES_URL not set)');
  }

  if (REDIS_URL) {
    console.log('\n[3/6] redis');
    const persistence = createPhase7RuntimePersistence({
      backend: 'redis',
      redisUrl: REDIS_URL,
      redisKeyPrefix: `weave:phase7:${Date.now()}`,
    });
    await runPhase7Scenario('redis', persistence);
    await persistence.close();
  } else {
    console.log('\n[3/6] redis');
    console.log('  - skipped (WEAVE_PHASE7_EXAMPLE_REDIS_URL not set)');
  }

  console.log('\n[4/6] sqlite');
  const sqlitePath = SQLITE_PATH ?? join(tmpdir(), `weave-phase7-${Date.now()}.db`);
  rmSync(sqlitePath, { force: true });
  const sqlitePersistence = createPhase7RuntimePersistence({ backend: 'sqlite', sqlitePath });
  await runPhase7Scenario('sqlite', sqlitePersistence);
  await sqlitePersistence.close();
  rmSync(sqlitePath, { force: true });

  if (MONGODB_URL) {
    console.log('\n[5/6] mongodb');
    const persistence = createPhase7RuntimePersistence({
      backend: 'mongodb',
      mongoUrl: MONGODB_URL,
      mongoDatabaseName: 'weave_phase7_example',
      mongoCollectionName: 'runtime_entries',
    });
    await runPhase7Scenario('mongodb', persistence);
    await persistence.close();
  } else {
    console.log('\n[5/6] mongodb');
    console.log('  - skipped (WEAVE_PHASE7_EXAMPLE_MONGODB_URL not set)');
  }

  if (DYNAMODB_ENDPOINT) {
    console.log('\n[6/6] cloud-nosql dynamodb');
    const persistence = createPhase7RuntimePersistence({
      backend: 'cloud-nosql',
      cloudNoSqlProvider: 'dynamodb',
      dynamoDbEndpoint: DYNAMODB_ENDPOINT,
      dynamoDbRegion: DYNAMODB_REGION,
      dynamoDbTableName: DYNAMODB_TABLE,
    });
    await runPhase7Scenario('cloud-nosql', persistence);
    await persistence.close();
  } else {
    console.log('\n[6/6] cloud-nosql dynamodb');
    console.log('  - skipped (WEAVE_PHASE7_EXAMPLE_DYNAMODB_ENDPOINT not set)');
  }

  console.log('\nPhase 7 persistence scenarios completed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
