/**
 * @weaveintel/provider-openai — OpenAI Fine-tuning adapter
 *
 * Implements the generic FineTuningProvider contract using OpenAI's
 * Fine-tuning API. Supports job creation, listing, retrieval,
 * cancellation, and event streaming.
 */

import type {
  ExecutionContext,
  FineTuningProvider,
  FineTuneRequest,
  FineTuneJob,
  FineTuneEvent,
  FineTuneListOptions,
} from '@weaveintel/core';
import { deadlineSignal, normalizeError } from '@weaveintel/core';
import {
  type OpenAIProviderOptions,
  DEFAULT_BASE_URL,
  resolveApiKey,
  makeHeaders,
  openaiRequest,
  openaiGetRequest,
} from './shared.js';

// ─── Mappers ─────────────────────────────────────────────────

function parseJob(raw: Record<string, unknown>): FineTuneJob {
  const hp = raw['hyperparameters'] as Record<string, unknown> | undefined;
  return {
    id: String(raw['id']),
    model: String(raw['model'] ?? ''),
    fineTunedModel: raw['fine_tuned_model'] as string | undefined,
    status: String(raw['status'] ?? 'queued') as FineTuneJob['status'],
    trainingFile: String(raw['training_file'] ?? ''),
    validationFile: raw['validation_file'] as string | undefined,
    hyperparameters: hp
      ? {
          nEpochs: hp['n_epochs'] as number | 'auto' | undefined,
          batchSize: hp['batch_size'] as number | 'auto' | undefined,
          learningRateMultiplier: hp['learning_rate_multiplier'] as number | 'auto' | undefined,
        }
      : undefined,
    trainedTokens: raw['trained_tokens'] as number | undefined,
    createdAt: Number(raw['created_at'] ?? 0),
    finishedAt: raw['finished_at'] as number | undefined,
    error: raw['error'] as { message: string; code?: string } | undefined,
  };
}

function parseEvent(raw: Record<string, unknown>): FineTuneEvent {
  return {
    type: String(raw['type'] ?? 'message'),
    createdAt: Number(raw['created_at'] ?? 0),
    level: (String(raw['level'] ?? 'info') as 'info' | 'warn' | 'error'),
    message: String(raw['message'] ?? raw['data'] ?? ''),
    data: raw['data'] as Record<string, unknown> | undefined,
  };
}

// ─── OpenAI Fine-tuning adapter ──────────────────────────────

export function weaveOpenAIFineTuningProvider(
  providerOptions?: OpenAIProviderOptions,
): FineTuningProvider {
  const opts = providerOptions ?? {};
  const apiKey = resolveApiKey(opts);
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const headers = makeHeaders(opts, apiKey);

  return {
    async create(ctx: ExecutionContext, request: FineTuneRequest): Promise<FineTuneJob> {
      const signal = deadlineSignal(ctx);
      try {
        const body: Record<string, unknown> = {
          model: request.model,
          training_file: request.trainingFile,
        };
        if (request.validationFile) body['validation_file'] = request.validationFile;
        if (request.suffix) body['suffix'] = request.suffix;
        if (request.hyperparameters) {
          const hp: Record<string, unknown> = {};
          if (request.hyperparameters.nEpochs !== undefined) hp['n_epochs'] = request.hyperparameters.nEpochs;
          if (request.hyperparameters.batchSize !== undefined) hp['batch_size'] = request.hyperparameters.batchSize;
          if (request.hyperparameters.learningRateMultiplier !== undefined) hp['learning_rate_multiplier'] = request.hyperparameters.learningRateMultiplier;
          body['hyperparameters'] = hp;
        }
        if (request.metadata) body['metadata'] = request.metadata;

        const raw = (await openaiRequest(baseUrl, '/fine_tuning/jobs', body, headers, signal)) as Record<string, unknown>;
        return parseJob(raw);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async list(ctx: ExecutionContext, options?: FineTuneListOptions): Promise<FineTuneJob[]> {
      const signal = deadlineSignal(ctx);
      try {
        let path = '/fine_tuning/jobs';
        const params: string[] = [];
        if (options?.limit) params.push(`limit=${options.limit}`);
        if (options?.after) params.push(`after=${encodeURIComponent(options.after)}`);
        if (params.length) path += `?${params.join('&')}`;
        const raw = (await openaiGetRequest(baseUrl, path, headers, signal)) as Record<string, unknown>;
        return ((raw['data'] as unknown[]) ?? []).map((d) => parseJob(d as Record<string, unknown>));
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async retrieve(ctx: ExecutionContext, jobId: string): Promise<FineTuneJob> {
      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiGetRequest(baseUrl, `/fine_tuning/jobs/${encodeURIComponent(jobId)}`, headers, signal)) as Record<string, unknown>;
        return parseJob(raw);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async cancel(ctx: ExecutionContext, jobId: string): Promise<FineTuneJob> {
      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiRequest(baseUrl, `/fine_tuning/jobs/${encodeURIComponent(jobId)}/cancel`, {}, headers, signal)) as Record<string, unknown>;
        return parseJob(raw);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async listEvents(ctx: ExecutionContext, jobId: string): Promise<FineTuneEvent[]> {
      const signal = deadlineSignal(ctx);
      try {
        const path = `/fine_tuning/jobs/${encodeURIComponent(jobId)}/events`;
        const raw = (await openaiGetRequest(baseUrl, path, headers, signal)) as Record<string, unknown>;
        return ((raw['data'] as unknown[]) ?? []).map((d) => parseEvent(d as Record<string, unknown>));
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },
  };
}

/** Convenience function */
export function weaveOpenAIFineTuning(options?: OpenAIProviderOptions): FineTuningProvider {
  return weaveOpenAIFineTuningProvider(options);
}
