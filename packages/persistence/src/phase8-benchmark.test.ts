import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createPhase8PersistenceBenchmark } from './phase8-benchmark.js';

describe('phase8 persistence benchmark', () => {
  it('produces latency, throughput, failover, and chaos metrics in-memory', async () => {
    const benchmark = createPhase8PersistenceBenchmark({
      persistence: { backend: 'in-memory' },
      iterationCount: 8,
      concurrency: 2,
      namespace: `phase8-test-memory-${Date.now()}`,
    });

    const report = await benchmark.run();

    expect(report.iterationCount).toBe(8);
    expect(report.writeThroughput.totalOps).toBe(8);
    expect(report.readThroughput.totalOps).toBe(8);
    expect(report.claimThroughput.totalOps).toBe(8);
    expect(report.writeLatency.p95Ms).toBeGreaterThanOrEqual(0);
    expect(report.failover.healthBefore.healthy).toBe(true);
    expect(report.failover.healthAfterRestart.healthy).toBe(true);
    expect(report.failover.replayCheckpointRecovered).toBe(true);
    expect(report.chaos.injectedFailures).toBe(1);
    expect(report.chaos.recoveredByRetry).toBeGreaterThanOrEqual(1);
    expect(report.chaos.unrecoveredFailures).toBe(0);

    await benchmark.close();
  });

  it('survives sqlite restart in failover checks', async () => {
    const sqlitePath = join(tmpdir(), `phase8-benchmark-${Date.now()}.db`);
    rmSync(sqlitePath, { force: true });

    const benchmark = createPhase8PersistenceBenchmark({
      persistence: { backend: 'sqlite', sqlitePath },
      iterationCount: 6,
      concurrency: 2,
      namespace: `phase8-test-sqlite-${Date.now()}`,
    });

    const report = await benchmark.run();
    expect(report.failover.replayCheckpointRecovered).toBe(true);
    expect(report.failover.healthAfterRestart.healthy).toBe(true);

    await benchmark.close();
    rmSync(sqlitePath, { force: true });
  });
});
