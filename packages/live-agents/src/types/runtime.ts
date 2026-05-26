import type { ExecutionContext, Tracer, RunLog, StepLog, ContextCompressor } from '@weaveintel/core';
import type { AgentContract, LiveAgent } from './mesh.js';
import type { StateStore } from './store.js';
import type { ExternalEvent } from './messaging.js';

export interface Heartbeat {
  tick(ctx: ExecutionContext): Promise<{ processed: number }>;
  run(ctx: ExecutionContext): Promise<void>;
  stop(): Promise<void>;
}

export interface LiveAgentsRunLogger {
  startRun(executionId: string, startTime?: number): void;
  recordStep(executionId: string, step: Omit<StepLog, 'index'>): void;
  completeRun(executionId: string, status: RunLog['status'], endTime?: number): void;
  getRunLog(executionId: string): RunLog | null;
  listRunLogs(): RunLog[];
}

export interface LiveAgentsObservability {
  tracer?: Tracer;
  runLogger?: LiveAgentsRunLogger;
}

export interface HeartbeatRunOptions {
  leaseDurationMs?: number;
  runPollIntervalMs?: number;
  observability?: LiveAgentsObservability;
  shouldPauseAgent?: (args: {
    ctx: ExecutionContext;
    contract: AgentContract | null;
    agent: LiveAgent;
  }) => { shouldPause: boolean; reason: string };
}

export interface CompressionMaintainer {
  run(ctx: ExecutionContext): Promise<void>;
  stop(): Promise<void>;
}

export interface ExternalEventHandler {
  process(event: ExternalEvent, ctx: ExecutionContext): Promise<{ routedMessageCount: number }>;
}

export interface LiveAgentsRuntime {
  readonly stateStore: StateStore;
  readonly compressors: Map<string, ContextCompressor>;
}
