/**
 * Example 63 — Phase 8 Persistence Performance and Reliability E2E
 *
 * This example executes a load/failover/chaos benchmark for the persistence
 * methods introduced in previous phases. It validates:
 * - latency percentiles (p50/p95/p99)
 * - throughput (ops/second)
 * - simulated failover restart durability
 * - retry-based recovery under injected transient failures
 *
 * Run:
 *   node --import tsx examples/63-phase8-persistence-performance-reliability-e2e.ts
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPhase8PersistenceBenchmark } from '@weaveintel/persistence';

const POSTGRES_URL = process.env['WEAVE_PHASE8_EXAMPLE_POSTGRES_URL'];
const REDIS_URL = process.env['WEAVE_PHASE8_EXAMPLE_REDIS_URL'];
const SQLITE_PATH = process.env['WEAVE_PHASE8_EXAMPLE_SQLITE_PATH'];
const MONGODB_URL = process.env['WEAVE_PHASE8_EXAMPLE_MONGODB_URL'];
const DYNAMODB_ENDPOINT = process.env['WEAVE_PHASE8_EXAMPLE_DYNAMODB_ENDPOINT'];
const DYNAMODB_REGION = process.env['WEAVE_PHASE8_EXAMPLE_DYNAMODB_REGION'] ?? 'us-east-1';
const DYNAMODB_TABLE = process.env['WEAVE_PHASE8_EXAMPLE_DYNAMODB_TABLE'] ?? 'weave_phase8_runtime';

function printSummary(label: string, report: Awaited<ReturnType<ReturnType<typeof createPhase8PersistenceBenchmark>['run']>>): void {
  console.log(
    `  ✓ ${label} p95(write/read/claim)=${report.writeLatency.p95Ms.toFixed(2)}/${report.readLatency.p95Ms.toFixed(2)}/${report.claimLatency.p95Ms.toFixed(2)}ms`,
  );
  console.log(
    `    throughput(write/read/claim)=${report.writeThroughput.opsPerSecond.toFixed(2)}/${report.readThroughput.opsPerSecond.toFixed(2)}/${report.claimThroughput.opsPerSecond.toFixed(2)} ops/s`,
  );
  console.log(
    `    failoverRecovered=${report.failover.replayCheckpointRecovered} chaosRecovered=${report.chaos.recoveredByRetry}/${Math.max(report.chaos.injectedFailures, 1)}`,
  );
}

async function runBenchmark(label: string, benchmark: ReturnType<typeof createPhase8PersistenceBenchmark>): Promise<void> {
  const report = await benchmark.run();
  printSummary(label, report);
  await benchmark.close();
}

async function main(): Promise<void> {
  console.log('Phase 8 persistence performance/reliability E2E');

  console.log('\n[1/6] in-memory benchmark');
  await runBenchmark('memory', createPhase8PersistenceBenchmark({
    persistence: { backend: 'in-memory' },
    iterationCount: 40,
    concurrency: 8,
  }));

  if (POSTGRES_URL) {
    console.log('\n[2/6] postgres benchmark');
    await runBenchmark('postgres', createPhase8PersistenceBenchmark({
      persistence: { backend: 'postgres', postgresUrl: POSTGRES_URL },
      iterationCount: 40,
      concurrency: 8,
    }));
  } else {
    console.log('\n[2/6] postgres benchmark');
    console.log('  - skipped (WEAVE_PHASE8_EXAMPLE_POSTGRES_URL not set)');
  }

  if (REDIS_URL) {
    console.log('\n[3/6] redis benchmark');
    await runBenchmark('redis', createPhase8PersistenceBenchmark({
      persistence: { backend: 'redis', redisUrl: REDIS_URL, redisKeyPrefix: `weave:phase8:${Date.now()}` },
      iterationCount: 40,
      concurrency: 8,
    }));
  } else {
    console.log('\n[3/6] redis benchmark');
    console.log('  - skipped (WEAVE_PHASE8_EXAMPLE_REDIS_URL not set)');
  }

  console.log('\n[4/6] sqlite benchmark');
  const sqlitePath = SQLITE_PATH ?? join(tmpdir(), `weave-phase8-${Date.now()}.db`);
  rmSync(sqlitePath, { force: true });
  await runBenchmark('sqlite', createPhase8PersistenceBenchmark({
    persistence: { backend: 'sqlite', sqlitePath },
    iterationCount: 40,
    concurrency: 8,
  }));
  rmSync(sqlitePath, { force: true });

  if (MONGODB_URL) {
    console.log('\n[5/6] mongodb benchmark');
    await runBenchmark('mongodb', createPhase8PersistenceBenchmark({
      persistence: {
        backend: 'mongodb',
        mongoUrl: MONGODB_URL,
        mongoDatabaseName: 'weave_phase8_example',
        mongoCollectionName: 'runtime_entries',
      },
      iterationCount: 40,
      concurrency: 8,
    }));
  } else {
    console.log('\n[5/6] mongodb benchmark');
    console.log('  - skipped (WEAVE_PHASE8_EXAMPLE_MONGODB_URL not set)');
  }

  if (DYNAMODB_ENDPOINT) {
    console.log('\n[6/6] cloud-nosql dynamodb benchmark');
    await runBenchmark('cloud-nosql', createPhase8PersistenceBenchmark({
      persistence: {
        backend: 'cloud-nosql',
        cloudNoSqlProvider: 'dynamodb',
        dynamoDbEndpoint: DYNAMODB_ENDPOINT,
        dynamoDbRegion: DYNAMODB_REGION,
        dynamoDbTableName: DYNAMODB_TABLE,
      },
      iterationCount: 40,
      concurrency: 8,
    }));
  } else {
    console.log('\n[6/6] cloud-nosql dynamodb benchmark');
    console.log('  - skipped (WEAVE_PHASE8_EXAMPLE_DYNAMODB_ENDPOINT not set)');
  }

  console.log('\nPhase 8 persistence benchmark scenarios completed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
