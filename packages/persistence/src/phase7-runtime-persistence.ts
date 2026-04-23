import type {
  EvalSuiteResult,
  ExecutionContext,
  MemoryEntry,
  SpanRecord,
  WorkflowCheckpoint,
} from '@weaveintel/core';
import { createConfiguredMemoryStore, type ConfiguredMemoryStoreOptions } from '@weaveintel/memory';

const PHASE7_ENTRY_TYPE = 'working';
const TRACE_CATEGORY = 'phase7_trace_span';
const REPLAY_CATEGORY = 'phase7_replay_checkpoint';
const EVAL_CATEGORY = 'phase7_eval_suite_run';
const DEFAULT_TOP_K = 10_000;

export interface Phase7RuntimePersistenceOptions extends ConfiguredMemoryStoreOptions {
  /**
   * Optional namespace used to isolate phase-7 records when sharing one backend
   * across multiple apps or environments.
   */
  namespace?: string;
}

export interface PersistedTraceSpan {
  id: string;
  executionId: string;
  traceId: string;
  span: SpanRecord;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface PersistedReplayCheckpoint {
  id: string;
  runId: string;
  checkpoint: WorkflowCheckpoint;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface PersistedEvalSuiteRun {
  id: string;
  executionId: string;
  evalName: string;
  result: EvalSuiteResult;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface TraceSpanFilter {
  executionId?: string;
  traceId?: string;
}

export interface EvalSuiteRunFilter {
  executionId?: string;
  evalName?: string;
}

export interface Phase7RuntimePersistence {
  saveTraceSpan(
    ctx: ExecutionContext,
    input: Omit<PersistedTraceSpan, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
  ): Promise<string>;
  listTraceSpans(ctx: ExecutionContext, filter?: TraceSpanFilter): Promise<PersistedTraceSpan[]>;
  saveReplayCheckpoint(
    ctx: ExecutionContext,
    input: Omit<PersistedReplayCheckpoint, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
  ): Promise<string>;
  loadLatestReplayCheckpoint(ctx: ExecutionContext, runId: string): Promise<PersistedReplayCheckpoint | null>;
  saveEvalSuiteRun(
    ctx: ExecutionContext,
    input: Omit<PersistedEvalSuiteRun, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
  ): Promise<string>;
  listEvalSuiteRuns(ctx: ExecutionContext, filter?: EvalSuiteRunFilter): Promise<PersistedEvalSuiteRun[]>;
  close(): Promise<void>;
}

export function createPhase7RuntimePersistence(
  options: Phase7RuntimePersistenceOptions,
): Phase7RuntimePersistence {
  // We intentionally reuse the configured memory-store backend layer from Phase 6.
  // This gives Phase 7 the same backend matrix (in-memory/postgres/redis/sqlite/
  // mongodb/cloud-nosql) without duplicating backend clients in this package.
  const store = createConfiguredMemoryStore(options);
  // Namespace lets operators isolate multiple app environments that share one DB.
  // Example: "staging" and "prod" can write to the same table safely.
  const namespace = options.namespace ?? 'default';

  function nowIso(): string {
    return new Date().toISOString();
  }

  function randomId(prefix: string): string {
    return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  }

  function createEntry(
    ctx: ExecutionContext,
    args: {
      id: string;
      category: string;
      content: string;
      createdAt: string;
      metadata: Record<string, unknown>;
    },
  ): MemoryEntry {
    // Every persisted artefact becomes a normal MemoryEntry with a strongly-tagged
    // category + namespace. This keeps Phase 7 records queryable through existing
    // memory-store APIs while preserving strict filtering semantics.
    return {
      id: args.id,
      type: PHASE7_ENTRY_TYPE,
      content: args.content,
      metadata: {
        ...args.metadata,
        phaseCategory: args.category,
        phaseNamespace: namespace,
      },
      createdAt: args.createdAt,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    };
  }

  async function listPhase7Entries(
    ctx: ExecutionContext,
    category: string,
  ): Promise<MemoryEntry[]> {
    // Query once, then filter in-process by category/namespace to keep behavior
    // backend-agnostic. Backends differ in query capabilities, but this path keeps
    // correctness deterministic across all adapters.
    const rows = await store.query(ctx, {
      type: PHASE7_ENTRY_TYPE,
      topK: DEFAULT_TOP_K,
      filter: {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
      },
    });

    return rows
      .filter((row) => row.metadata['phaseCategory'] === category)
      .filter((row) => row.metadata['phaseNamespace'] === namespace)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  function parseJson<T>(value: string): T {
    return JSON.parse(value) as T;
  }

  return {
    async saveTraceSpan(ctx, input): Promise<string> {
      // Trace records persist the raw SpanRecord payload; executionId + traceId are
      // duplicated into metadata for fast filtering without JSON parsing.
      const id = input.id ?? randomId('trace');
      const createdAt = input.createdAt ?? nowIso();
      const entry = createEntry(ctx, {
        id,
        category: TRACE_CATEGORY,
        content: JSON.stringify(input.span),
        createdAt,
        metadata: {
          executionId: input.executionId,
          traceId: input.traceId,
          metadata: input.metadata ?? {},
        },
      });
      await store.write(ctx, [entry]);
      return id;
    },

    async listTraceSpans(ctx, filter): Promise<PersistedTraceSpan[]> {
      const rows = await listPhase7Entries(ctx, TRACE_CATEGORY);
      return rows
        .map((row) => {
          const meta = row.metadata;
          return {
            id: row.id,
            executionId: String(meta['executionId'] ?? ''),
            traceId: String(meta['traceId'] ?? ''),
            span: parseJson<SpanRecord>(row.content),
            createdAt: row.createdAt,
            metadata: (meta['metadata'] as Record<string, unknown> | undefined) ?? {},
          } satisfies PersistedTraceSpan;
        })
        .filter((item) => !filter?.executionId || item.executionId === filter.executionId)
        .filter((item) => !filter?.traceId || item.traceId === filter.traceId);
    },

    async saveReplayCheckpoint(ctx, input): Promise<string> {
      // Replay checkpoints are stored as full workflow checkpoint objects so run
      // recovery can rehydrate exact checkpoint state after process restarts.
      const id = input.id ?? randomId('replay');
      const createdAt = input.createdAt ?? nowIso();
      const entry = createEntry(ctx, {
        id,
        category: REPLAY_CATEGORY,
        content: JSON.stringify(input.checkpoint),
        createdAt,
        metadata: {
          runId: input.runId,
          stepId: input.checkpoint.stepId,
          metadata: input.metadata ?? {},
        },
      });
      await store.write(ctx, [entry]);
      return id;
    },

    async loadLatestReplayCheckpoint(ctx, runId): Promise<PersistedReplayCheckpoint | null> {
      const rows = await listPhase7Entries(ctx, REPLAY_CATEGORY);
      // "Latest" is defined by createdAt descending, which keeps behavior stable
      // even when backends do not support server-side ordering for JSON payloads.
      const matches = rows
        .filter((row) => String(row.metadata['runId'] ?? '') === runId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const latest = matches[0];
      if (!latest) {
        return null;
      }
      return {
        id: latest.id,
        runId: String(latest.metadata['runId'] ?? runId),
        checkpoint: parseJson<WorkflowCheckpoint>(latest.content),
        createdAt: latest.createdAt,
        metadata: (latest.metadata['metadata'] as Record<string, unknown> | undefined) ?? {},
      };
    },

    async saveEvalSuiteRun(ctx, input): Promise<string> {
      // Eval suite results are preserved in full to retain case-level diagnostics.
      // This enables post-run audits and trend analysis without re-executing suites.
      const id = input.id ?? randomId('eval');
      const createdAt = input.createdAt ?? nowIso();
      const entry = createEntry(ctx, {
        id,
        category: EVAL_CATEGORY,
        content: JSON.stringify(input.result),
        createdAt,
        metadata: {
          executionId: input.executionId,
          evalName: input.evalName,
          metadata: input.metadata ?? {},
        },
      });
      await store.write(ctx, [entry]);
      return id;
    },

    async listEvalSuiteRuns(ctx, filter): Promise<PersistedEvalSuiteRun[]> {
      const rows = await listPhase7Entries(ctx, EVAL_CATEGORY);
      return rows
        .map((row) => {
          const meta = row.metadata;
          return {
            id: row.id,
            executionId: String(meta['executionId'] ?? ''),
            evalName: String(meta['evalName'] ?? ''),
            result: parseJson<EvalSuiteResult>(row.content),
            createdAt: row.createdAt,
            metadata: (meta['metadata'] as Record<string, unknown> | undefined) ?? {},
          } satisfies PersistedEvalSuiteRun;
        })
        .filter((item) => !filter?.executionId || item.executionId === filter.executionId)
        .filter((item) => !filter?.evalName || item.evalName === filter.evalName);
    },

    async close(): Promise<void> {
      // Always close the underlying store to release DB pools/clients where needed.
      await store.close();
    },
  };
}
