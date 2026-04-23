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
  const store = createConfiguredMemoryStore(options);
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
      await store.close();
    },
  };
}
