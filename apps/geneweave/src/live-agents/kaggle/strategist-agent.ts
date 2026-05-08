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
  wrapAdapterWithResilience,
  type KaggleAdapter,
  type KaggleCredentials,
} from '@weaveintel/tools-kaggle';
import { createKaggleTools, type KernelPushRecord, type ToolBlockedRecord } from './kaggle-tools.js';
import { withPerTickReadCache } from './adapter-cache.js';
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
  /**
   * Best-effort observer for every successful `kaggle_push_kernel`. Wired by
   * the heartbeat boot path to a closure that resolves the active
   * `kgl_competition_run` row by mesh id and writes a structured
   * `kgl_run_event` (kind=`kernel_pushed`) capturing the canonical Kaggle-
   * returned `kernelRef`, version, requested slug/title, codeBytes, and
   * pushedAt — so the operator can query "which kernels were pushed for
   * run X" without scraping `tool_audit_events.output_preview` JSON.
   * Throws are swallowed by the underlying tool — never blocks the push.
   */
  onKernelPushed?: (record: KernelPushRecord) => Promise<void> | void;
  /**
   * Best-effort observer invoked the FIRST time any kaggle_* tool returns a
   * structured `rate_limited` rejection within a tick. The boot path wires
   * this to insert a `kgl_run_event` (kind=`tool_blocked`) so the operator
   * can see in run-detail that the tick yielded due to Kaggle account
   * pressure. Throws are swallowed by the underlying tool — never blocks.
   */
  onToolBlocked?: (record: ToolBlockedRecord) => Promise<void> | void;
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
  const adapter = wrapAdapterWithResilience(opts.adapter ?? liveKaggleAdapter);
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
    prepare: async ({ inbound, context }) => {
      const inboundBody = inbound?.body?.trim() ?? '';
      const competitionSlug = extractCompetitionSlugFromText(inboundBody);
      const meshId = context?.agent?.meshId ?? undefined;
      const agentId = context?.agent?.id ?? undefined;
      log(
        `inbound subject="${inbound?.subject ?? '(none)'}" bodyLen=${inboundBody.length} ` +
          `competitionSlug="${competitionSlug || '(none)'}" meshId="${meshId ?? '(none)'}"`,
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

      // Per-tick push cap. Default 1 in production: the LLM observably
      // ignored prompt-level "AT MOST ONE push" rules, and the agentic
      // handoff only forwards the LAST kernel to the validator anyway.
      // Playbooks may raise it (e.g. an exploratory probe phase) by setting
      // `maxKernelPushesPerTick` in the playbook config JSON.
      const maxKernelPushesPerTick =
        typeof resolvedConfig['maxKernelPushesPerTick'] === 'number'
          ? (resolvedConfig['maxKernelPushesPerTick'] as number)
          : 1;
      const tools = createKaggleTools({
        adapter: withPerTickReadCache(adapter),
        credentials,
        maxKernelPushesPerTick,
        defaults: {
          defaultWaitTimeoutSec: resolvedConfig['pollTimeoutSec'] as number | undefined,
          maxWaitTimeoutSec: resolvedConfig['kernelWaitMaxTimeoutSec'] as number | undefined,
          defaultPollIntervalSec: resolvedConfig['pollIntervalSec'] as number | undefined,
          outputHeadBytes: resolvedConfig['kernelOutputHeadBytes'] as number | undefined,
          outputTailBytes: resolvedConfig['kernelOutputTailBytes'] as number | undefined,
        },
        ...(opts.onKernelPushed
          ? {
              onKernelPushed: async (record: KernelPushRecord) => {
                // Per-tick decoration: stamp meshId/agentId so the boot-path
                // closure can resolve the active kgl_competition_run row by
                // mesh without an extra query parameter.
                await opts.onKernelPushed?.({
                  ...record,
                  ...(meshId ? { meshId } : {}),
                  ...(agentId ? { agentId } : {}),
                });
              },
            }
          : {}),
        ...(opts.onToolBlocked
          ? {
              onToolBlocked: async (record: ToolBlockedRecord) => {
                await opts.onToolBlocked?.({
                  ...record,
                  ...(meshId ? { meshId } : {}),
                  ...(agentId ? { agentId } : {}),
                });
              },
            }
          : {}),
      });

      // Phase-progression override on validator bounce-back. Without it the
      // LLM re-reads the playbook from the top each tick (which marks
      // Phase 0 probe and Phase 1 teacher as MANDATORY) and re-pushes the
      // same early-phase kernels forever — observed behavior is 5+
      // teacher-data-generation pushes inside a single ReAct tick.
      // Trigger: inbound subject "Validation failed for <comp> iteration N"
      // (set by handlers/validator.ts L196). The override (a) tells the
      // LLM exactly which phase to execute this turn based on N, and
      // (b) caps tool spam at one push per turn.
      const inboundSubject = inbound?.subject ?? '';
      const iterationMatch = inboundSubject.match(/Validation failed for [^\s]+ iteration (\d+)/i);
      const failedIteration = iterationMatch ? Number(iterationMatch[1]) : 0;
      const isBounceBack =
        failedIteration > 0 ||
        /"kernelStatus"\s*:\s*"probe_only"/.test(inboundBody) ||
        /Phase 0\.5 diagnostic probe kernel/.test(inboundBody) ||
        /AGENT_PROBE_DONE/.test(inboundBody);

      // Phase mapping derived from the playbook's iteration budget:
      //   failedIter 1 → Phase 2 (BC + final main.py with def agent())
      //   failedIter 2 → Phase 3 attempt 1 (one ML knob improvement)
      //   failedIter 3 → Phase 3 attempt 2
      //   failedIter ≥ 4 → Phase 3 attempt N (or stop on win_rate ≥ 0.85)
      const phaseDirective = (() => {
        if (failedIteration <= 1) {
          return `NEXT PHASE = Phase 2 (Behavior Cloning + FINAL submission kernel).
Required actions THIS TURN, in order:
  1. ONE kaggle_push_kernel call. Title pattern: <competition>-it2-bc-v1.
  2. The kernel MUST contain ALL of: feature builder, sklearn classifier fit on the teacher pickle from iteration 1, pickle dump of policy.pkl, AND a top-level def agent(observation, configuration) that loads policy.pkl and returns int(model.predict(features(observation))[0]).
  3. The kernel MUST also self-evaluate by running env.run([agent, "random"]) for ≥20 matches and printing "AGENT_RESULT_CV_SCORES={\"win_rate_vs_random\": <x>}".
  4. Then ONE kaggle_wait_for_kernel + ONE kaggle_get_kernel_output on the EXACT kernelRef returned by step 1.
  5. Update BEST scratchpad with the result and STOP. Do NOT push variants this turn.`;
        }
        if (failedIteration === 2) {
          return `NEXT PHASE = Phase 3 attempt 1 (one ML improvement on the BC baseline).
Required actions THIS TURN, in order:
  1. ONE kaggle_push_kernel call. Pick exactly ONE knob to change vs the BEST kernel: more teacher episodes (200→1000), OR larger MLP / GradientBoosting hyperparams, OR added action-mask features. Title pattern: <competition>-it3-<knob>.
  2. ONE kaggle_wait_for_kernel + ONE kaggle_get_kernel_output on the returned kernelRef.
  3. Compare win_rate vs BEST. Update BEST only if STRICTLY higher. STOP. Do NOT push variants.`;
        }
        return `NEXT PHASE = Phase 3 attempt ${failedIteration - 1} (one further ML improvement on BEST).
Required actions THIS TURN, in order:
  1. ONE kaggle_push_kernel call. Pick exactly ONE different ML knob vs prior attempts (e.g. self-play vs frozen BEST, RL fine-tune from BC warm-start, LightGBM if available). Title pattern: <competition>-it${failedIteration + 1}-<knob>.
  2. ONE kaggle_wait_for_kernel + ONE kaggle_get_kernel_output.
  3. If win_rate ≥ 0.85 OR you have made 8 total push attempts, emit final response with FINAL block referencing BEST.kernelRef. Otherwise update BEST and STOP. Do NOT push variants.`;
      })();

      const probeOverride = isBounceBack
        ? `⚠️ STRATEGIST RE-ENTRY (failed iteration=${failedIteration || '?'}).
Phase 0 (probe) and Phase 1 (teacher data generation) are ALREADY COMPLETE for this competition. DO NOT push another probe / environment-listing / teacher-data-generation kernel — those phases are DONE.

${phaseDirective}

HARD RULE THIS TURN: AT MOST ONE kaggle_push_kernel call. After that one push, your only allowed tool calls are kaggle_wait_for_kernel and kaggle_get_kernel_output for the kernelRef just returned. Pushing two or more kernels in one turn wastes Kaggle API budget and blocks progress.

The validator's prior verdict is in the inbound body below — read it, then execute the phase above.

`
        : '';
      const userGoal = inboundBody
        ? `${probeOverride}Seed message from operator:\n${inboundBody}\n\nProceed per the workflow.`
        : `No specific competition was named. Pick the most tractable active competition and proceed.`;
      if (isBounceBack) {
        log(`inbound is bounce-back (failedIter=${failedIteration}) — prepended phase-progression override to userGoal.`);
      }

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

  // Machine-readable kernel-result block — consumed by the agentic strategist
  // handoff (handlers/strategist.ts) so the kernel(s) the LLM actually pushed
  // this tick reach the validator instead of being dropped at the deterministic
  // implementer (which bails when no playbook.solverTemplate matches).
  const kernel = extractLatestKernelFromSteps(toolSteps);
  const kernelBlock = kernel
    ? `\n---KERNEL_HANDOFF_JSON---\n${JSON.stringify(kernel)}\n---END_KERNEL_HANDOFF_JSON---`
    : '';

  return [
    `status=${result.status} toolCalls=${toolSteps.length} totalSteps=${result.steps.length}`,
    `--- tool trace ---`,
    trace.length > 0 ? trace.join('\n') : '(no tool calls)',
    `--- final response ---`,
    finalText.length > 1500 ? finalText.slice(0, 1500) + '... [truncated]' : finalText,
    kernelBlock,
  ].join('\n');
}

/** Walk tool_call steps and reconstruct the latest kernel push + its
 *  poll/output results. Returns null when no `kaggle_push_kernel` landed
 *  this tick. Tool result strings come back as `{"content":"<json>"}`. */
function extractLatestKernelFromSteps(toolSteps: ReadonlyArray<ToolCallStep>): {
  kernelRef: string;
  kernelUrl: string;
  kernelStatus: string;
  failureMessage: string | null;
  outputFiles: string[];
  logExcerpt: string;
} | null {
  const unwrap = (raw: string | undefined): Record<string, unknown> | null => {
    if (!raw) return null;
    try {
      const outer = JSON.parse(raw) as { content?: string } | Record<string, unknown>;
      const inner = (outer as { content?: string }).content;
      if (typeof inner === 'string') {
        try {
          return JSON.parse(inner) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
      return outer as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  let kernelRef = '';
  let kernelUrl = '';
  let pushedSource = '';
  for (let i = toolSteps.length - 1; i >= 0; i--) {
    const tc = toolSteps[i]?.toolCall;
    if (tc?.name !== 'kaggle_push_kernel') continue;
    const parsed = unwrap(tc.result);
    if (parsed && typeof parsed['kernelRef'] === 'string' && parsed['kernelRef']) {
      kernelRef = parsed['kernelRef'] as string;
      kernelUrl = (parsed['kernelUrl'] as string | undefined) ?? '';
      const args = tc.arguments ?? {};
      const src =
        (args['source'] as string | undefined) ??
        (args['code'] as string | undefined) ??
        (args['script'] as string | undefined) ??
        '';
      pushedSource = typeof src === 'string' ? src : '';
      break;
    }
  }
  if (!kernelRef) return null;

  // Probe-only detection: the strategist's playbook (Phase 0.5) tells it to
  // push a tiny diagnostic probe kernel to verify env names BEFORE pushing
  // the real solver. The probe is NEVER a submission. If the latest push
  // contains the AGENT_PROBE_DONE marker and no obvious solver scaffolding,
  // tag this kernel so the validator's bounce-back gives the LLM concrete
  // corrective guidance instead of a generic "no submission file" message.
  const looksLikeProbeOnly =
    pushedSource.includes('AGENT_PROBE_DONE') &&
    !/submission\.(csv|json|py)|class\s+\w+Agent\b|def\s+act\b|\.to_csv\(/i.test(pushedSource);

  const refMatches = (args?: Record<string, unknown>): boolean => {
    if (!args) return false;
    const r = (args['ref'] as string | undefined) ?? (args['kernelRef'] as string | undefined) ?? '';
    if (r === kernelRef) return true;
    const tail = kernelRef.split('/').pop() ?? '';
    return tail.length > 0 && r.endsWith('/' + tail);
  };

  let kernelStatus = 'pushed';
  let failureMessage: string | null = null;
  for (let i = toolSteps.length - 1; i >= 0; i--) {
    const tc = toolSteps[i]?.toolCall;
    if (tc?.name !== 'kaggle_wait_for_kernel') continue;
    if (!refMatches(tc.arguments)) continue;
    const parsed = unwrap(tc.result);
    if (parsed) {
      kernelStatus = (parsed['status'] as string | undefined) ?? kernelStatus;
      const fm = parsed['failureMessage'];
      failureMessage = typeof fm === 'string' && fm.length > 0 ? fm : failureMessage;
      break;
    }
  }

  let outputFiles: string[] = [];
  let logExcerpt = '';
  for (let i = toolSteps.length - 1; i >= 0; i--) {
    const tc = toolSteps[i]?.toolCall;
    if (tc?.name !== 'kaggle_get_kernel_output') continue;
    if (!refMatches(tc.arguments)) continue;
    const parsed = unwrap(tc.result);
    if (parsed) {
      const files = parsed['files'];
      if (Array.isArray(files)) outputFiles = files.map((f) => String(f));
      const logVal = parsed['log'];
      if (typeof logVal === 'string') logExcerpt = logVal.slice(0, 4000);
      break;
    }
  }

  if (looksLikeProbeOnly) {
    kernelStatus = 'probe_only';
    failureMessage =
      'Strategist pushed only the Phase 0.5 diagnostic probe kernel (contains AGENT_PROBE_DONE marker, no solver / submission code detected). Per the playbook, the probe is NEVER a submission — after reading the probe log you must push another kernel that contains the actual solver/agent code that writes the required submission file (or IS the submission for kernel_is_submission competitions). Bouncing back so the strategist can push the real solver next iteration.';
  }

  return { kernelRef, kernelUrl, kernelStatus, failureMessage, outputFiles, logExcerpt };
}
