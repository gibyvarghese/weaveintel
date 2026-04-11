/**
 * @weaveintel/core — Fine-tuning contracts
 *
 * Why: Fine-tuning is a key capability for customizing model behavior.
 * This contract abstracts fine-tuning job management so any provider's
 * fine-tuning API is consumable through the same interface.
 */

import type { ExecutionContext } from './context.js';

// ─── Fine-tuning types ───────────────────────────────────────

export interface FineTuneRequest {
  readonly trainingFile: string;
  readonly model: string;
  readonly validationFile?: string;
  readonly suffix?: string;
  readonly hyperparameters?: FineTuneHyperparameters;
  readonly metadata?: Record<string, unknown>;
}

export interface FineTuneHyperparameters {
  readonly nEpochs?: number | 'auto';
  readonly batchSize?: number | 'auto';
  readonly learningRateMultiplier?: number | 'auto';
}

export type FineTuneStatus =
  | 'validating_files'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface FineTuneJob {
  readonly id: string;
  readonly model: string;
  readonly fineTunedModel?: string;
  readonly status: FineTuneStatus;
  readonly createdAt: number;
  readonly finishedAt?: number;
  readonly trainingFile: string;
  readonly validationFile?: string;
  readonly hyperparameters?: FineTuneHyperparameters;
  readonly trainedTokens?: number;
  readonly error?: { readonly message: string; readonly code?: string };
  readonly metadata?: Record<string, unknown>;
}

export interface FineTuneEvent {
  readonly type: string;
  readonly createdAt: number;
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export interface FineTuneListOptions {
  readonly limit?: number;
  readonly after?: string;
}

// ─── Fine-tuning provider interface ──────────────────────────

export interface FineTuningProvider {
  create(ctx: ExecutionContext, request: FineTuneRequest): Promise<FineTuneJob>;
  list(ctx: ExecutionContext, options?: FineTuneListOptions): Promise<FineTuneJob[]>;
  retrieve(ctx: ExecutionContext, jobId: string): Promise<FineTuneJob>;
  cancel(ctx: ExecutionContext, jobId: string): Promise<FineTuneJob>;
  listEvents(ctx: ExecutionContext, jobId: string): Promise<FineTuneEvent[]>;
}
