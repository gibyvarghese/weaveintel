import { weaveContext, type ExecutionContext } from '@weaveintel/core';
import {
  createConcurrencyLimiter,
  createHealthChecker,
  createRetryBudget,
  type HealthStatus,
} from '@weaveintel/reliability';
import {
  createPhase7RuntimePersistence,
  type Phase7RuntimePersistence,
  type Phase7RuntimePersistenceOptions,
} from './phase7-runtime-persistence.js';

export type Phase8BenchmarkScenario = 'write' | 'read' | 'claim';

export interface Phase8BenchmarkOptions {
  persistence: Phase7RuntimePersistenceOptions;
  iterationCount: number;
  concurrency: number;
  retryBudget?: {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  namespace?: string;
}

export interface Phase8LatencySummary {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  avgMs: number;
}

export interface Phase8ThroughputSummary {
  opsPerSecond: number;
  totalOps: number;
  totalDurationMs: number;
}

export interface Phase8BenchmarkReport {
  backend: Phase7RuntimePersistenceOptions['backend'];
  namespace: string;
  iterationCount: number;
  concurrency: number;
  writeLatency: Phase8LatencySummary;
  readLatency: Phase8LatencySummary;
  claimLatency: Phase8LatencySummary;
  writeThroughput: Phase8ThroughputSummary;
  readThroughput: Phase8ThroughputSummary;
  claimThroughput: Phase8ThroughputSummary;
  failover: {
    healthBefore: HealthStatus;
    healthAfterRestart: HealthStatus;
    replayCheckpointRecovered: boolean;
  };
  chaos: {
    injectedFailures: number;
    recoveredByRetry: number;
    unrecoveredFailures: number;
  };
}

export interface Phase8PersistenceBenchmark {
  run(ctx?: ExecutionContext): Promise<Phase8BenchmarkReport>;
  close(): Promise<void>;
}

interface MeasuredResult {
  durationMs: number;
  recoveredByRetry: boolean;
}

export function createPhase8PersistenceBenchmark(
  options: Phase8BenchmarkOptions,
): Phase8PersistenceBenchmark {
  const namespace = options.namespace ?? `phase8:${Date.now()}`;
  let persistence = createPhase7RuntimePersistence({
    ...options.persistence,
    namespace,
  });

  let syntheticFailureInjected = false;
  let syntheticFailureRecovered = false;

  const limiter = createConcurrencyLimiter({
    maxConcurrent: Math.max(1, options.concurrency),
    maxQueued: Math.max(options.iterationCount * 2, 100),
    strategy: 'queue',
  });

  const retry = createRetryBudget({
    maxRetries: options.retryBudget?.maxRetries ?? 2,
    baseDelayMs: options.retryBudget?.baseDelayMs ?? 5,
    maxDelayMs: options.retryBudget?.maxDelayMs ?? 25,
  });

  function createScenarioContext(base?: ExecutionContext): ExecutionContext {
    if (base) {
      return base;
    }
    return weaveContext({
      tenantId: `phase8-tenant-${namespace}`,
      userId: `phase8-user-${namespace}`,
      metadata: { sessionId: `phase8-session-${namespace}` },
    });
  }

  function quantile(sorted: readonly number[], q: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
    return sorted[index] ?? 0;
  }

  function summarizeLatency(values: readonly number[]): Phase8LatencySummary {
    const sorted = [...values].sort((left, right) => left - right);
    const sum = sorted.reduce((acc, value) => acc + value, 0);
    return {
      p50Ms: quantile(sorted, 0.5),
      p95Ms: quantile(sorted, 0.95),
      p99Ms: quantile(sorted, 0.99),
      maxMs: sorted[sorted.length - 1] ?? 0,
      avgMs: sorted.length > 0 ? sum / sorted.length : 0,
    };
  }

  function summarizeThroughput(totalOps: number, totalDurationMs: number): Phase8ThroughputSummary {
    const opsPerSecond = totalDurationMs > 0 ? (totalOps / totalDurationMs) * 1000 : 0;
    return {
      opsPerSecond,
      totalOps,
      totalDurationMs,
    };
  }

  async function measureOperation(op: () => Promise<void>): Promise<MeasuredResult> {
    const start = Date.now();
    let recoveredByRetry = false;
    let injectedThisOperation = false;

    let shouldInjectFailure = false;
    if (!syntheticFailureInjected) {
      syntheticFailureInjected = true;
      shouldInjectFailure = true;
      injectedThisOperation = true;
    }

    await retry.execute(async () => {
      if (shouldInjectFailure) {
        shouldInjectFailure = false;
        throw new Error('phase8:synthetic:retryable');
      }
      await op();
      if (injectedThisOperation) {
        recoveredByRetry = true;
      }
    });

    if (recoveredByRetry) {
      syntheticFailureRecovered = true;
    }

    return {
      durationMs: Date.now() - start,
      recoveredByRetry,
    };
  }

  async function runScenario(
    ctx: ExecutionContext,
    scenario: Phase8BenchmarkScenario,
  ): Promise<{ durations: number[]; throughput: Phase8ThroughputSummary; recoveredByRetryCount: number }> {
    const durations: number[] = [];
    let recoveredByRetryCount = 0;
    const startedAt = Date.now();

    const tasks = Array.from({ length: options.iterationCount }, (_unused, index) =>
      limiter.execute(async () => {
        const id = `${namespace}:${scenario}:${index}`;
        const result = await measureOperation(async () => {
          if (scenario === 'write') {
            await persistence.saveTraceSpan(ctx, {
              id,
              executionId: ctx.executionId,
              traceId: `${namespace}:trace`,
              span: {
                traceId: `${namespace}:trace`,
                spanId: `${namespace}:span:${index}`,
                parentSpanId: undefined,
                name: `${namespace}:${scenario}`,
                startTime: Date.now(),
                endTime: Date.now(),
                status: 'ok',
                attributes: { index },
                events: [],
              },
              metadata: { scenario, index },
            });
            return;
          }

          if (scenario === 'read') {
            await persistence.listTraceSpans(ctx, {
              executionId: ctx.executionId,
            });
            return;
          }

          await persistence.saveReplayCheckpoint(ctx, {
            id,
            runId: `${namespace}:run`,
            checkpoint: {
              id: `${id}:checkpoint`,
              runId: `${namespace}:run`,
              workflowId: `${namespace}:workflow`,
              stepId: `step-${index}`,
              createdAt: new Date().toISOString(),
              state: {
                currentStepId: `step-${index}`,
                variables: { scenario },
                history: [],
              },
            },
            metadata: { scenario, index },
          });
          await persistence.loadLatestReplayCheckpoint(ctx, `${namespace}:run`);
        });

        durations.push(result.durationMs);
        if (result.recoveredByRetry) {
          recoveredByRetryCount += 1;
        }
      }),
    );

    await Promise.all(tasks);

    const elapsed = Date.now() - startedAt;
    return {
      durations,
      throughput: summarizeThroughput(options.iterationCount, elapsed),
      recoveredByRetryCount,
    };
  }

  async function runFailoverCheck(ctx: ExecutionContext): Promise<{
    healthBefore: HealthStatus;
    healthAfterRestart: HealthStatus;
    replayCheckpointRecovered: boolean;
  }> {
    const healthChecker = createHealthChecker('phase8-persistence');

    healthChecker.addCheck('write_trace', async () => {
      try {
        await persistence.saveTraceSpan(ctx, {
          executionId: ctx.executionId,
          traceId: `${namespace}:health`,
          span: {
            traceId: `${namespace}:health`,
            spanId: `${namespace}:health:span`,
            parentSpanId: undefined,
            name: 'phase8-health-span',
            startTime: Date.now(),
            endTime: Date.now(),
            status: 'ok',
            attributes: {},
            events: [],
          },
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    });

    healthChecker.addCheck('checkpoint_roundtrip', async () => {
      try {
        await persistence.saveReplayCheckpoint(ctx, {
          runId: `${namespace}:failover:run`,
          checkpoint: {
            id: `${namespace}:failover:checkpoint`,
            runId: `${namespace}:failover:run`,
            workflowId: `${namespace}:failover:workflow`,
            stepId: 'failover-step',
            createdAt: new Date().toISOString(),
            state: {
              currentStepId: 'failover-step',
              variables: {},
              history: [],
            },
          },
        });
        const restored = await persistence.loadLatestReplayCheckpoint(ctx, `${namespace}:failover:run`);
        return { ok: restored !== null };
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    });

    const healthBefore = await healthChecker.run();

    // Simulated failover: close and reopen the persistence layer with same backend+namespace.
    await persistence.close();
    persistence = createPhase7RuntimePersistence({
      ...options.persistence,
      namespace,
    });

    const healthAfterRestart = await healthChecker.run();
    const recoveredCheckpoint = await persistence.loadLatestReplayCheckpoint(ctx, `${namespace}:failover:run`);

    return {
      healthBefore,
      healthAfterRestart,
      replayCheckpointRecovered: recoveredCheckpoint !== null,
    };
  }

  return {
    async run(ctx): Promise<Phase8BenchmarkReport> {
      const benchmarkCtx = createScenarioContext(ctx);

      // Prime the store so read/claim loops have realistic data.
      await persistence.saveTraceSpan(benchmarkCtx, {
        executionId: benchmarkCtx.executionId,
        traceId: `${namespace}:prime`,
        span: {
          traceId: `${namespace}:prime`,
          spanId: `${namespace}:prime:span`,
          parentSpanId: undefined,
          name: 'phase8-prime',
          startTime: Date.now(),
          endTime: Date.now(),
          status: 'ok',
          attributes: {},
          events: [],
        },
      });

      const write = await runScenario(benchmarkCtx, 'write');
      const read = await runScenario(benchmarkCtx, 'read');
      const claim = await runScenario(benchmarkCtx, 'claim');
      const failover = await runFailoverCheck(benchmarkCtx);

      const recoveredByRetry =
        write.recoveredByRetryCount + read.recoveredByRetryCount + claim.recoveredByRetryCount;

      return {
        backend: options.persistence.backend,
        namespace,
        iterationCount: options.iterationCount,
        concurrency: options.concurrency,
        writeLatency: summarizeLatency(write.durations),
        readLatency: summarizeLatency(read.durations),
        claimLatency: summarizeLatency(claim.durations),
        writeThroughput: write.throughput,
        readThroughput: read.throughput,
        claimThroughput: claim.throughput,
        failover,
        chaos: {
          injectedFailures: syntheticFailureInjected ? 1 : 0,
          recoveredByRetry,
          unrecoveredFailures: syntheticFailureInjected && recoveredByRetry === 0 ? 1 : 0,
        },
      };
    },

    async close(): Promise<void> {
      await persistence.close();
    },
  };
}
