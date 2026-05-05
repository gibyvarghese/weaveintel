/**
 * Kaggle Strategist agent — Kaggle-specific glue around the platform's
 * generic `createAgenticTaskHandler` (from `@weaveintel/live-agents`).
 *
 * This file is now a thin adapter that resolves Kaggle credentials, builds
 * Kaggle tools, and looks up a DB-backed playbook for the system prompt.
 * The reusable ReAct loop, inbound-task loading, and `weaveAgent` invocation
 * all live in the package.
 *
 * --- LLM CALL SITE ---
 * The actual `agent.run(...)` invocation happens inside the package's
 * `createAgenticTaskHandler` (see
 * packages/live-agents/src/agentic-task-handler.ts). This file never calls
 * the model directly — it just configures the handler.
 *
 * Submission to Kaggle is intentionally NOT exposed as a tool — submission
 * is a human-approved Promotion in the live-agents framework.
 */

import type { Model } from '@weaveintel/core';
import {
  weaveLiveAgent,
  type AgenticRunResult,
  type LiveAgentPolicy,
  type TaskHandler,
} from '@weaveintel/live-agents';
import {
  liveKaggleAdapter,
  type KaggleAdapter,
  type KaggleCredentials,
} from '@weaveintel/tools-kaggle';
import { createKaggleTools } from './kaggle-tools.js';
import {
  extractCompetitionSlugFromText,
  type KagglePlaybookResolver,
} from './playbook-resolver.js';

export interface KaggleStrategistAgentOptions {
  model: Model;
  adapter?: KaggleAdapter;
  credentials?: KaggleCredentials;
  /** Maximum tool-call loops the agent runs in a single tick. */
  maxSteps?: number;
  /** Optional logger. */
  log?: (msg: string) => void;
  /**
   * Resolves competition playbooks from the DB. Called per tick with the
   * inbound competition slug (or '' when no slug is detectable). When the
   * resolver returns null, the strategist falls back to `fallbackGoalText`
   * if provided, or to a minimal hard-coded discovery prompt.
   */
  playbookResolver?: KagglePlaybookResolver;
  /**
   * Static system prompt used as a fallback when no `playbookResolver` is
   * configured (e.g. unit tests, prompt-debugging examples). Production
   * deployments should always wire `playbookResolver` so prompts are
   * DB-driven.
   */
  fallbackGoalText?: string;
  /**
   * Phase 3 (live-agents capability parity) — first-class per-tick policy
   * bundle (resolver / approval gate / rate limiter / audit emitter).
   * Forwarded to `weaveLiveAgent` so every kaggle tool call inside the
   * strategist's ReAct loop is gated by the same DB-backed pipeline
   * operators administer for chat. When omitted, tool calls run
   * unenforced (legacy behavior).
   */
  policy?: LiveAgentPolicy;
}

/** Last-resort prompt — used only when neither playbookResolver nor
 *  fallbackGoalText is provided. Deliberately minimal; production wires the
 *  DB resolver. */
const HARDCODED_FALLBACK_GOAL = `You are a Kaggle research agent. The operator has not configured a playbook for this competition. List active competitions, pick a tractable one, push a small scout kernel that explores /kaggle/input and prints AGENT_RESULT, and report back. Do not submit.`;

/** Framework-wide CV-scores requirement appended to every resolved playbook
 *  prompt. Phase K7d: the validator role compares cv_score against the
 *  competition's auto-inferred rubric baseline_score. To do this without
 *  hand-tuning per competition, every kernel must emit a sibling
 *  `cv_scores.json` alongside `submission.csv`. This addendum is competition-
 *  agnostic — it never names a metric, fold count, or model — so it works
 *  for any Kaggle competition the strategist tackles. */
const CV_SCORES_ADDENDUM = `

## Required: emit cv_scores.json alongside submission.csv

For every kernel that produces a submission, you MUST also write a
\`cv_scores.json\` file in the kernel working directory with this exact
schema (use the same evaluation metric Kaggle reports for this competition):

\`\`\`json
{
  "cv_metric": "<metric name, e.g. 'accuracy', 'rmse', 'auc'>",
  "cv_score": <mean cross-validated score on the local training data>,
  "cv_std": <standard deviation of fold scores>,
  "n_folds": <integer number of folds used>,
  "baseline_score": <optional: simple-baseline score (e.g. predict-majority) for sanity>
}
\`\`\`

The downstream Submission Validator parses this file to gate submissions
against the competition's leaderboard baseline. If the file is missing or
malformed, the validator marks the run as fail and bounces back. Always
print \`AGENT_RESULT_CV_SCORES=<one-line-json>\` immediately before
\`AGENT_RESULT\` so log inspection works even when output downloads fail.`;

export function createKaggleStrategistHandler(opts: KaggleStrategistAgentOptions): TaskHandler {
  const adapter = opts.adapter ?? liveKaggleAdapter;
  const credentials = opts.credentials ?? resolveCredentialsFromEnv();
  const log = opts.log ?? ((m: string) => console.log(`[kaggle-strategist] ${m}`));
  const maxSteps = opts.maxSteps ?? 90;

  const { handler } = weaveLiveAgent({
    name: 'kaggle-strategist',
    model: opts.model,
    maxSteps,
    log,
    summarize: summarizeKaggleRun,
    ...(opts.policy ? { policy: opts.policy } : {}),
    onError: async (err) => {
      // Detect Anthropic rate-limit and back off long enough for the per-minute
      // window to drain. Without this, the heartbeat re-dispatches every tick
      // and we burn the entire TPM budget on retries before any tool call lands.
      const text = err instanceof Error ? err.message : String(err);
      if (/rate limit/i.test(text) || /\b429\b/.test(text)) {
        log('rate-limit detected; sleeping 65s before next attempt');
        await new Promise((resolve) => setTimeout(resolve, 65_000));
      }
    },
    prepare: async ({ inbound }) => {
      const inboundBody = inbound?.body?.trim() ?? '';
      const competitionSlug = extractCompetitionSlugFromText(inboundBody);
      log(
        `inbound subject="${inbound?.subject ?? '(none)'}" bodyLen=${inboundBody.length} ` +
          `competitionSlug="${competitionSlug || '(none)'}"`,
      );

      // Resolve system prompt + tool defaults from the DB playbook.
      let systemPrompt = opts.fallbackGoalText ?? HARDCODED_FALLBACK_GOAL;
      let playbookSummary = 'fallback (no resolver)';
      let resolvedConfig: Record<string, unknown> = {};
      if (opts.playbookResolver) {
        try {
          const playbook = await opts.playbookResolver(competitionSlug);
          if (playbook) {
            systemPrompt = playbook.systemPrompt;
            resolvedConfig = playbook.config as unknown as Record<string, unknown>;
            playbookSummary = `${playbook.name} (matched=${playbook.matchedPattern}, shape=${playbook.config.shape ?? 'unknown'})`;
          } else if (opts.fallbackGoalText) {
            playbookSummary = 'fallback (no playbook matched)';
          }
        } catch (err) {
          log(`!! playbookResolver threw: ${err instanceof Error ? err.message : String(err)} — using fallback prompt`);
        }
      }
      log(`playbook=${playbookSummary} promptBytes=${systemPrompt.length}`);

      // Phase K7d: append framework-wide cv_scores.json requirement so every
      // competition the strategist tackles emits the artifact the validator
      // needs to gate submissions.
      systemPrompt = systemPrompt + CV_SCORES_ADDENDUM;

      const tools = createKaggleTools({
        adapter,
        credentials,
        defaults: {
          defaultWaitTimeoutSec: resolvedConfig['pollTimeoutSec'] as number | undefined,
          maxWaitTimeoutSec: resolvedConfig['kernelWaitMaxTimeoutSec'] as number | undefined,
          defaultPollIntervalSec: resolvedConfig['pollIntervalSec'] as number | undefined,
          outputHeadBytes: resolvedConfig['kernelOutputHeadBytes'] as number | undefined,
          outputTailBytes: resolvedConfig['kernelOutputTailBytes'] as number | undefined,
        },
      });

      const userGoal = inboundBody
        ? `Seed message from operator:\n${inboundBody}\n\nProceed per the workflow.`
        : `No specific competition was named. Pick the most tractable active competition and proceed.`;

      return { systemPrompt, tools, userGoal };
    },
  });
  return handler;
}

function resolveCredentialsFromEnv(): KaggleCredentials {
  const username = process.env['KAGGLE_USERNAME'];
  const key = process.env['KAGGLE_KEY'];
  if (!username || !key) {
    throw new Error('KAGGLE_USERNAME and KAGGLE_KEY must be set in env for the Kaggle strategist agent.');
  }
  return { username, key };
}

interface ToolCallStep {
  type: string;
  content?: string;
  toolCall?: { name: string; arguments?: Record<string, unknown>; result?: string };
}

/** Kaggle-specific summary that highlights kernel pushes and preserves URLs. */
function summarizeKaggleRun(result: AgenticRunResult): string {
  const steps = result.steps as ReadonlyArray<ToolCallStep>;
  const last = [...steps].reverse().find((s) => s.type === 'response');
  const finalText = last?.content ?? '(no final response)';
  const toolSteps = steps.filter((s) => s.type === 'tool_call' && s.toolCall);
  const trace: string[] = [];
  for (const s of toolSteps) {
    const tc = s.toolCall!;
    const name = tc.name;
    const args = tc.arguments ?? {};
    let argSummary = '';
    if (name === 'kaggle_push_kernel') {
      argSummary = `slug=${String(args['slug'] ?? '')} title=${String(args['title'] ?? '')} comp=${String(args['competitionRef'] ?? '')} codeBytes=${String((args['code'] as string | undefined)?.length ?? 0)}`;
    } else {
      argSummary = JSON.stringify(args).slice(0, 200);
    }
    let resultSummary = (tc.result ?? '').slice(0, 400).replace(/\s+/g, ' ');
    // Always preserve full kernel URLs for inspection.
    const urlMatches = (tc.result ?? '').match(/https?:\/\/[^\s",]+/g);
    if (urlMatches && urlMatches.length > 0) {
      resultSummary += ` | URLs: ${urlMatches.join(' ')}`;
    }
    trace.push(`  • ${name}(${argSummary}) -> ${resultSummary}`);
  }
  return [
    `status=${result.status} toolCalls=${toolSteps.length} totalSteps=${result.steps.length}`,
    `--- tool trace ---`,
    trace.length > 0 ? trace.join('\n') : '(no tool calls)',
    `--- final response ---`,
    finalText.length > 1500 ? finalText.slice(0, 1500) + '... [truncated]' : finalText,
  ].join('\n');
}
