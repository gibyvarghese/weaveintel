/**
 * Phase 4 — DB-driven attention policy factory.
 *
 * Converts a `live_attention_policies` DB row into a live `AttentionPolicy`
 * instance. This is the runtime bridge between the operator-configurable
 * policy catalogue and the actual scheduling behaviour of each agent.
 *
 * Design decisions:
 *
 *  - Pure adapter: does not read from DB directly; callers supply a resolved
 *    row (e.g. loaded via `getLiveAttentionPolicyByKey`). This keeps the
 *    package free of DB dependencies.
 *
 *  - Delegates to shared `@weaveintel/live-agents` policy factories so logic
 *    is never duplicated. The factory is intentionally thin — one `switch`
 *    over `row.kind`.
 *
 *  - Safe by default: any unknown `kind` falls back to the standard heuristic
 *    policy and logs a warning rather than throwing. Callers should treat the
 *    return value as always valid.
 *
 *  - `resolveAttentionPolicyFromDb()` wraps the DB lookup for callers that
 *    have a `DatabaseAdapterLike` interface but want a single async helper
 *    rather than two calls.
 */

import type { Model } from '@weaveintel/core';
import {
  createStandardAttentionPolicy,
  createCronAttentionPolicy,
  createModelAttentionPolicy,
  type AttentionPolicy,
} from '@weaveintel/live-agents';

// ---------------------------------------------------------------------------
// Minimal DB interface (subset of DatabaseAdapter) — lets callers inject
// the full GeneWeave adapter without this package depending on geneweave.
// ---------------------------------------------------------------------------

/**
 * Minimal subset of the GeneWeave `DatabaseAdapter` that this factory needs.
 * Any object exposing `getLiveAttentionPolicyByKey` satisfies this interface.
 */
export interface AttentionPolicyDb {
  getLiveAttentionPolicyByKey(key: string): Promise<AttentionPolicyRowLike | null>;
}

/**
 * Shape of a `live_attention_policies` row.  Mirrors `LiveAttentionPolicyRow`
 * from `@weaveintel/geneweave` without taking a dependency on the app package.
 */
export interface AttentionPolicyRowLike {
  id: string;
  key: string;
  /** 'heuristic' | 'cron' | 'model' */
  kind: string;
  description: string;
  /** JSON-encoded configuration. Shape varies by kind (see below). */
  config_json: string;
  enabled: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Runtime options forwarded to the attention policy constructor.
 *
 * - `model` is required when resolving a `kind = 'model'` policy.
 * - `logger` receives diagnostic messages (e.g. fallback warnings).
 */
export interface AttentionFactoryOptions {
  /**
   * LLM model instance.  Required for `kind = 'model'` policies; ignored
   * for heuristic and cron kinds.
   */
  model?: Model;
  /**
   * Optional logger for warnings (e.g. unknown `kind`, missing model, invalid
   * `config_json`). Defaults to `console.warn`.
   */
  logger?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Config shapes per kind
// ---------------------------------------------------------------------------

/** Config fields recognised for `kind = 'heuristic'` rows. */
interface HeuristicConfig {
  /** Reserved for future triggers. Currently unused — all heuristic rows
   *  use the standard inbox-first priority order. */
  trigger?: string;
  /** Override rest interval in minutes (default: 15). */
  restMinutes?: number;
}

/** Config fields recognised for kind = 'cron' rows. */
interface CronConfig {
  /** Standard 5-field cron expression, e.g. '0 * * * *' (hourly). */
  cron?: string;
  /** Explicit rest duration in minutes (overrides `cron`-derived value). */
  restMinutes?: number;
  /**
   * When `true`, process inbox/backlog normally; rest only when idle.
   * When `false` (default), always rest — pure sweep/discovery agent.
   */
  processInbox?: boolean;
}

/** Config fields recognised for `kind = 'model'` rows. */
interface ModelConfig {
  /** Scoring strategy hint (reserved for future routing extensions). */
  scorer?: string;
  /** Minimum confidence threshold for model-selected actions (0–1). */
  threshold?: number;
  /** Max inbox items passed to the model per tick (default: 25). */
  maxInboxItems?: number;
  /** Max backlog items passed to the model per tick (default: 25). */
  maxBacklogItems?: number;
  /** Temperature for the model call (default: 0). */
  temperature?: number;
  /** Token budget for model response (default: 700). */
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParse<T>(json: string, fallback: T): T {
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Core factory
// ---------------------------------------------------------------------------

/**
 * Converts a `live_attention_policies` DB row into a live `AttentionPolicy`.
 *
 * @example
 * const row = await db.getLiveAttentionPolicyByKey('cron.rest-only');
 * if (row) {
 *   const policy = resolveAttentionPolicy(row, {});
 *   const action = await policy.decide(context, execCtx);
 * }
 */
export function resolveAttentionPolicy(
  row: AttentionPolicyRowLike,
  opts: AttentionFactoryOptions,
): AttentionPolicy {
  const log = opts.logger ?? ((msg: string) => console.warn('[attention-factory]', msg));

  switch (row.kind) {
    // ------------------------------------------------------------------
    // heuristic — inbox-first priority queue, configurable rest interval
    // ------------------------------------------------------------------
    case 'heuristic': {
      const config = safeParse<HeuristicConfig>(row.config_json, {});
      // The standard policy always uses 15-minute rest; if the operator
      // configured a custom restMinutes we create a cron policy that processes
      // inbox but rests at the specified interval.
      if (config.restMinutes) {
        return createCronAttentionPolicy({
          key: row.key,
          restMinutes: config.restMinutes,
          processInbox: true,
        });
      }
      return createStandardAttentionPolicy();
    }

    // ------------------------------------------------------------------
    // cron — fixed-schedule rest, optionally processes inbox when available
    // ------------------------------------------------------------------
    case 'cron': {
      const config = safeParse<CronConfig>(row.config_json, {});
      return createCronAttentionPolicy({
        key: row.key,
        cronExpression: config.cron,
        restMinutes: config.restMinutes,
        processInbox: config.processInbox ?? false,
      });
    }

    // ------------------------------------------------------------------
    // model — LLM decides every tick, falls back to standard on error
    // ------------------------------------------------------------------
    case 'model': {
      if (!opts.model) {
        log(
          `Attention policy key='${row.key}' is kind='model' but no model was supplied. ` +
            'Falling back to standard heuristic policy.',
        );
        return createStandardAttentionPolicy();
      }
      const config = safeParse<ModelConfig>(row.config_json, {});
      return createModelAttentionPolicy({
        key: row.key,
        // The model is accessed via AttentionContext.model at decide() time,
        // so we don't pass it here — the policy uses context.model directly.
        fallbackPolicy: createStandardAttentionPolicy(),
        maxInboxItems: config.maxInboxItems,
        maxBacklogItems: config.maxBacklogItems,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      });
    }

    // ------------------------------------------------------------------
    // Unknown kind — safe fallback
    // ------------------------------------------------------------------
    default: {
      log(
        `Unknown attention policy kind='${row.kind}' for key='${row.key}'. ` +
          'Falling back to standard heuristic policy.',
      );
      return createStandardAttentionPolicy();
    }
  }
}

// ---------------------------------------------------------------------------
// DB-backed convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Loads a `live_attention_policies` row by key then returns the resolved
 * `AttentionPolicy`. Falls back to `createStandardAttentionPolicy()` when:
 *   - the key is not set (`null` / `undefined`)
 *   - no matching row is found in the DB
 *   - the row is disabled (`enabled = 0`)
 *
 * @param db     Minimal DB adapter exposing `getLiveAttentionPolicyByKey`.
 * @param key    The `attention_policy_key` stored on the agent row.
 * @param opts   Forward to `resolveAttentionPolicy` (model, logger).
 *
 * @example
 * // In a heartbeat tick: resolve the policy once and cache per agent.
 * const policy = await resolveAttentionPolicyFromDb(
 *   db, agent.attention_policy_key, { model: routedModel }
 * );
 * const action = await policy.decide(context, execCtx);
 */
export async function resolveAttentionPolicyFromDb(
  db: AttentionPolicyDb,
  key: string | null | undefined,
  opts: AttentionFactoryOptions = {},
): Promise<AttentionPolicy> {
  const log = opts.logger ?? ((msg: string) => console.warn('[attention-factory]', msg));

  if (!key) {
    // Agent has no explicit policy configured — use the safe default.
    return createStandardAttentionPolicy();
  }

  let row: AttentionPolicyRowLike | null;
  try {
    row = await db.getLiveAttentionPolicyByKey(key);
  } catch (err) {
    log(
      `Failed to load attention policy key='${key}' from DB: ${String(err)}. ` +
        'Falling back to standard heuristic policy.',
    );
    return createStandardAttentionPolicy();
  }

  if (!row) {
    log(
      `Attention policy key='${key}' not found in DB. ` +
        'Falling back to standard heuristic policy.',
    );
    return createStandardAttentionPolicy();
  }

  if (!row.enabled) {
    log(
      `Attention policy key='${key}' is disabled. ` +
        'Falling back to standard heuristic policy.',
    );
    return createStandardAttentionPolicy();
  }

  return resolveAttentionPolicy(row, opts);
}
