/**
 * Kaggle role-specific task handlers wired into the live-agents action executor.
 *
 * Each handler implements the real work for one role's StartTask action:
 *   - call the appropriate kaggle adapter / tool
 *   - emit a downstream message + backlog item to the next agent in the pipeline
 *   - return `completed: true` so the action executor marks this agent's
 *     backlog item COMPLETED rather than IN_PROGRESS
 *
 * Handlers are deliberately self-contained (no MCP session round-trip) so the
 * pipeline can run end-to-end with just KAGGLE_USERNAME / KAGGLE_KEY env vars.
 *
 * THIS FILE INTENTIONALLY CONTAINS NO COMPETITION-SPECIFIC LOGIC.
 * - Agentic mode (LLM strategist): system prompt comes from the DB playbook
 *   resolved per inbound competition slug.
 * - Deterministic mode (no LLM): the implementer asks the playbook resolver
 *   for a Python solver template + strategy presets keyed off the discovered
 *   competition slug. If no playbook matches, the deterministic implementer
 *   reports back without pushing — i.e. operators must seed a playbook for
 *   any competition they want to drive deterministically.
 */

import type {
  ActionExecutionContext,
  AttentionAction,
  TaskHandler,
  TaskHandlerResult,
} from '@weaveintel/live-agents';
import {
  liveKaggleAdapter,
  type KaggleCompetition,
  type KaggleAdapter,
  type KaggleCredentials,
} from '@weaveintel/tools-kaggle';
import type { Model } from '@weaveintel/core';
import type { KaggleAgentRole } from './account-bindings.js';
import { createKaggleStrategistHandler } from './strategist-agent.js';
import {
  extractCompetitionSlugFromText,
  type KagglePlaybook,
  type KagglePlaybookResolver,
} from './playbook-resolver.js';
import type { DatabaseAdapter } from '../../db.js';
import {
  runSubmissionValidation,
  observeLeaderboardOnce,
  type CvScoresArtifact,
} from '../../lib/kaggle-validator-runner.js';
import { randomUUID } from 'node:crypto';

const DEFAULT_MAX_ITERATIONS = 8;

/** Kaggle's pushKernel returns a ref like '/code/<owner>/<slug>' but its
 * status/output endpoints expect '<owner>/<slug>'. Normalize. */
function normalizeKernelRef(rawRef: string, kernelUrl: string): string {
  if (rawRef && !rawRef.startsWith('/')) return rawRef;
  const url = kernelUrl || rawRef;
  const m = url.match(/(?:code|kernels)\/([^/]+)\/([^/?#]+)/);
  if (m && m[1] && m[2]) return `${m[1]}/${m[2]}`;
  return rawRef;
}

async function pollKernelUntilTerminal(
  adapter: KaggleAdapter,
  creds: KaggleCredentials,
  kernelRef: string,
  log: (m: string) => void,
  pollIntervalMs: number,
  pollTimeoutMs: number,
): Promise<{ status: string; failureMessage: string | null; logExcerpt: string; outputFiles: string[] }> {
  const terminal = new Set(['complete', 'error', 'cancelled', 'cancelAcknowledged']);
  const maxAttempts = Math.max(1, Math.ceil(pollTimeoutMs / pollIntervalMs));
  let status = 'unknown';
  let failureMessage: string | null = null;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const st = await adapter.getKernelStatus(creds, kernelRef);
      status = st.status;
      failureMessage = st.failureMessage;
      log(`poll[${i}] ref=${kernelRef} status=${status}`);
      if (terminal.has(status)) break;
    } catch (err) {
      log(`poll[${i}] error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  let logExcerpt = '';
  let outputFiles: string[] = [];
  try {
    const out = await adapter.getKernelOutput(creds, kernelRef);
    outputFiles = out.files.map((f) => f.fileName);
    if (out.log) logExcerpt = out.log.slice(-2000);
  } catch (err) {
    log(`output fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { status, failureMessage, logExcerpt, outputFiles };
}

export interface KaggleRoleHandlersOptions {
  /** Override the kaggle adapter (defaults to the live REST adapter). */
  adapter?: KaggleAdapter;
  /** Override credential resolution (defaults to KAGGLE_USERNAME/KAGGLE_KEY env). */
  credentials?: KaggleCredentials;
  /** Optional console.log replacement. */
  log?: (msg: string) => void;
  /** LLM used by the strategist to plan each iteration. If absent, deterministic mode is used. */
  plannerModel?: Model;
  /**
   * Default iteration cap when no playbook matches (deterministic mode only).
   * The matched playbook's `examples.maxIterations` overrides this when present.
   */
  maxIterations?: number;
  /**
   * DB-backed playbook resolver. REQUIRED for production; without it the
   * agentic strategist falls back to a minimal hard-coded prompt and the
   * deterministic implementer cannot produce a kernel script.
   */
  playbookResolver?: KagglePlaybookResolver;
  /**
   * DB adapter for Phase K7d submission-validation persistence.
   * When provided, the validator and leaderboard-observer roles persist
   * kaggle_validation_results / kaggle_leaderboard_scores rows and auto-
   * infer rubrics on first contact with a competition. Optional: when
   * unset, both roles fall back to their pre-K7d behavior (passthrough/
   * no-op) so existing examples keep working.
   */
  db?: DatabaseAdapter;
  /** Tenant id for rubric scoping (Phase K7d). Defaults to null (global). */
  tenantId?: string | null;
}

function resolveCreds(opts: KaggleRoleHandlersOptions): KaggleCredentials {
  if (opts.credentials) return opts.credentials;
  const username = process.env['KAGGLE_USERNAME'];
  const key = process.env['KAGGLE_KEY'];
  if (!username || !key) {
    throw new Error(
      'Kaggle credentials missing: set KAGGLE_USERNAME and KAGGLE_KEY in env or pass credentials to createKaggleRoleHandlers.',
    );
  }
  return { username, key };
}

function nextAgentId(currentAgentId: string, nextRole: KaggleAgentRole): string {
  // Agent ids are `${meshId}::${role}` per mesh-template.ts
  const idx = currentAgentId.lastIndexOf('::');
  if (idx < 0) throw new Error(`Unexpected agent id shape: ${currentAgentId}`);
  return `${currentAgentId.slice(0, idx)}::${nextRole}`;
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Normalize whatever the Discoverer/Strategist embedded as competitionId
 * (slug, ref, or full Kaggle URL) into the slug Kaggle's API expects. */
function competitionSlugFrom(value: string): string {
  if (!value) return '';
  const m = value.match(/competitions\/([^/?#]+)/);
  if (m && m[1]) return m[1];
  return value.replace(/^\/+|\/+$/g, '');
}

async function emitToNextAgent(
  context: ActionExecutionContext,
  nextRole: KaggleAgentRole,
  subject: string,
  body: string,
  topic: string,
): Promise<{ messageId: string; backlogId: string; nextAgentId: string }> {
  const toId = nextAgentId(context.agent.id, nextRole);
  const messageId = makeId('msg');
  const backlogId = makeId('backlog');
  const nowIso = context.nowIso;

  await context.stateStore.saveMessage({
    id: messageId,
    meshId: context.agent.meshId,
    fromType: 'AGENT',
    fromId: context.agent.id,
    fromMeshId: context.agent.meshId,
    toType: 'AGENT',
    toId,
    topic,
    kind: 'TASK',
    replyToMessageId: null,
    threadId: messageId,
    contextRefs: [],
    contextPacketRef: null,
    expiresAt: null,
    priority: 'NORMAL',
    status: 'DELIVERED',
    deliveredAt: nowIso,
    readAt: null,
    processedAt: null,
    createdAt: nowIso,
    subject,
    body,
  });

  await context.stateStore.saveBacklogItem({
    id: backlogId,
    agentId: toId,
    priority: 'NORMAL',
    status: 'PROPOSED',
    originType: 'MESSAGE',
    originRef: messageId,
    blockedOnMessageId: null,
    blockedOnGrantRequestId: null,
    blockedOnPromotionRequestId: null,
    blockedOnAccountBindingRequestId: null,
    estimatedEffort: 'PT15M',
    deadline: null,
    acceptedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: nowIso,
    title: subject,
    description: body,
  });

  return { messageId, backlogId, nextAgentId: toId };
}

/** Read the most-recent inbound TASK message for this agent (any status). */
async function loadInboundTask(context: ActionExecutionContext): Promise<{ subject: string; body: string } | null> {
  const inbox = await context.stateStore.listMessagesForRecipient('AGENT', context.agent.id);
  // Pick the most recent TASK (handlers run after ProcessMessage marks it PROCESSED).
  const tasks = inbox.filter((m) => m.kind === 'TASK').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const m = tasks[0];
  return m ? { subject: m.subject, body: m.body } : null;
}

/** Best-effort JSON parse for inbound task bodies. Returns {} on parse error. */
function parseInboundJson(body: string | undefined | null): Record<string, unknown> {
  if (!body) return {};
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Resolve a playbook for the given slug, returning null when no resolver is
 *  configured or no playbook matches. Logs failures non-fatally. */
async function tryResolvePlaybook(
  resolver: KagglePlaybookResolver | undefined,
  slug: string,
  presetIndex: number,
  variables: Record<string, unknown>,
  log: (m: string) => void,
): Promise<KagglePlaybook | null> {
  if (!resolver) return null;
  try {
    return await resolver(slug, { presetIndex, variables });
  } catch (err) {
    log(`playbookResolver threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Resolve the catch-all (`*`) playbook ONCE at handler creation and return
 *  its operational defaults (top-N picks, kernel poll cadence). Falls back
 *  to historical hard-coded values when no resolver is wired or no catch-all
 *  matches — keeps tests/examples that don't seed the DB working. */
async function loadOperationalDefaults(
  resolver: KagglePlaybookResolver | undefined,
  log: (m: string) => void,
): Promise<{
  topNAgentic: number;
  topNDeterministic: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}> {
  const HARD_DEFAULTS = {
    topNAgentic: 5,
    topNDeterministic: 3,
    pollIntervalMs: 10_000,
    pollTimeoutMs: 300_000,
  };
  if (!resolver) return HARD_DEFAULTS;
  try {
    const pb = await resolver('');
    const cfg = pb?.config ?? {};
    return {
      topNAgentic: cfg.topNAgentic ?? HARD_DEFAULTS.topNAgentic,
      topNDeterministic: cfg.topNDeterministic ?? HARD_DEFAULTS.topNDeterministic,
      pollIntervalMs: (cfg.pollIntervalSec ?? 10) * 1000,
      pollTimeoutMs: (cfg.pollTimeoutSec ?? 300) * 1000,
    };
  } catch (err) {
    log(`loadOperationalDefaults failed: ${err instanceof Error ? err.message : String(err)}`);
    return HARD_DEFAULTS;
  }
}

export function createKaggleRoleHandlers(
  opts: KaggleRoleHandlersOptions = {},
): Record<string, TaskHandler> {
  const adapter = opts.adapter ?? liveKaggleAdapter;
  const log = opts.log ?? ((m: string) => console.log(`[kaggle-handler] ${m}`));

  // Lazy promise so we resolve the catch-all playbook exactly once and reuse.
  let opDefaultsPromise: Promise<{
    topNAgentic: number;
    topNDeterministic: number;
    pollIntervalMs: number;
    pollTimeoutMs: number;
  }> | null = null;
  const getOpDefaults = () => {
    if (!opDefaultsPromise) opDefaultsPromise = loadOperationalDefaults(opts.playbookResolver, log);
    return opDefaultsPromise;
  };

  // ── AGENTIC MODE ──────────────────────────────────────────
  // When a planner model is provided, replace the deterministic pipeline with
  // a single LLM-driven Strategist that runs a `weaveAgent` ReAct loop with
  // Kaggle tools. Discoverer just seeds the strategist; the rest are no-ops.
  if (opts.plannerModel) {
    const creds = resolveCreds(opts);
    const strategistAgentic = createKaggleStrategistHandler({
      model: opts.plannerModel,
      adapter,
      credentials: creds,
      maxSteps: opts.maxIterations ? Math.max(opts.maxIterations * 12, 40) : 60,
      log,
      playbookResolver: opts.playbookResolver,
    });

    const discovererSeed: TaskHandler = async (_action, context) => {
      log('Discoverer (agentic mode): seeding strategist with top competitions.');
      const opDefaults = await getOpDefaults();
      const pinnedSlug = process.env['KAGGLE_COMPETITION_SLUG']?.trim();
      let top: KaggleCompetition[];
      if (pinnedSlug) {
        log(`Discoverer: pinned to competition slug=${pinnedSlug}`);
        const comp = await adapter.getCompetition(creds, pinnedSlug);
        top = [comp];
      } else {
        const comps = await adapter.listCompetitions(creds, { page: 1 });
        top = comps.slice(0, opDefaults.topNAgentic);
      }
      const summary = top
        .map((c) => `- ${c.id} | ${c.title} | metric=${c.evaluationMetric ?? 'n/a'} | deadline=${c.deadline ?? 'n/a'}`)
        .join('\n');
      const body = [
        'Active competitions you may choose from (pick the most tractable one):',
        summary,
        '',
        'Proceed with the workflow described in your system prompt.',
      ].join('\n');
      await emitToNextAgent(
        context,
        'strategist',
        `Seed: ${top.length} candidate competitions`,
        body,
        'kaggle.discovery.seed',
      );
      return {
        completed: true,
        summaryProse: `Seeded strategist with ${top.length} candidate competitions.`,
      };
    };

    const strategistAgenticWithHandoff: TaskHandler = async (action, context, execCtx) => {
      const result = await strategistAgentic(action, context, execCtx);
      // Hand the agent's final summary off to the submitter so the existing
      // pipeline-completion check (submitter backlog COMPLETED) still fires.
      const summary = (result && 'summaryProse' in result && result.summaryProse) || 'Strategist agent finished.';
      await emitToNextAgent(
        context,
        'submitter',
        'Agentic strategist final summary',
        String(summary),
        'kaggle.strategy.final',
      );
      return result ?? { completed: true };
    };

    const noop: TaskHandler = async (_a, _c) => ({ completed: true, summaryProse: 'no-op (agentic mode)' });

    // Phase K7d — Submission Validator (agentic mode).
    // When `opts.db` is supplied, run the rubric-aware validator and persist
    // a kaggle_validation_results row. Without `opts.db`, falls back to noop.
    const validatorAgentic: TaskHandler = async (_a, context) => {
      if (!opts.db) return { completed: true, summaryProse: 'validator: no-op (no db wired)' };
      const inbound = await loadInboundTask(context);
      const parsed = parseInboundJson(inbound?.body);
      const competitionRef = (parsed['competitionId'] as string | undefined) ?? (parsed['competitionRef'] as string | undefined);
      if (!competitionRef) return { completed: true, summaryProse: 'validator: no competitionRef in inbound — skipping persistence' };
      const outputFiles = Array.isArray(parsed['outputFiles']) ? (parsed['outputFiles'] as string[]) : [];
      const kernelRef = (parsed['kernelRef'] as string | null | undefined) ?? null;
      const cvScores = parsed['cvScores'] as CvScoresArtifact | undefined ?? null;
      const runId = (parsed['runId'] as string | undefined) ?? `kgl-run-${randomUUID().slice(0, 8)}`;
      try {
        const result = await runSubmissionValidation({
          db: opts.db,
          adapter,
          credentials: creds,
          runId,
          competitionRef,
          tenantId: opts.tenantId ?? null,
          kernelRef,
          outputFiles,
          cvScores,
        });
        log(`validator: verdict=${result.verdict} rubric=${result.rubric.id} violations=${result.violations.length}`);
        return { completed: true, summaryProse: `Validator: ${result.summary}` };
      } catch (err) {
        log(`validator: persistence failed: ${err instanceof Error ? err.message : String(err)}`);
        return { completed: true, summaryProse: 'validator: persistence error (non-fatal)' };
      }
    };

    // Phase K7d — Leaderboard Observer (agentic mode).
    const observerAgentic: TaskHandler = async (_a, context) => {
      if (!opts.db) return { completed: true, summaryProse: 'observer: no-op (no db wired)' };
      const inbound = await loadInboundTask(context);
      const parsed = parseInboundJson(inbound?.body);
      const competitionRef = (parsed['competitionId'] as string | undefined) ?? (parsed['competitionRef'] as string | undefined);
      if (!competitionRef) return { completed: true, summaryProse: 'observer: no competitionRef in inbound — skipping' };
      const submissionRef = (parsed['submissionRef'] as string | null | undefined) ?? null;
      const cvScore = typeof parsed['cvScore'] === 'number' ? (parsed['cvScore'] as number) : null;
      const runId = (parsed['runId'] as string | undefined) ?? null;
      try {
        const result = await observeLeaderboardOnce({
          db: opts.db,
          adapter,
          credentials: creds,
          runId,
          competitionRef,
          submissionRef,
          cvScore,
        });
        log(`observer: observed=${result.observed} public=${result.publicScore} delta=${result.cvLbDelta}`);
        return {
          completed: true,
          summaryProse: result.observed
            ? `Observer: public_score=${result.publicScore} status=${result.rawStatus} delta=${result.cvLbDelta}`
            : 'Observer: no submissions yet.',
        };
      } catch (err) {
        log(`observer: persistence failed: ${err instanceof Error ? err.message : String(err)}`);
        return { completed: true, summaryProse: 'observer: persistence error (non-fatal)' };
      }
    };

    const submitter: TaskHandler = async (_a, context) => {
      const inbound = await loadInboundTask(context);
      log(
        `Submitter (agentic mode) received final summary (${inbound?.body.length ?? 0} bytes). ` +
          `Real submission requires dual-control approval; recording intent only.`,
      );
      return {
        completed: true,
        summaryProse: 'Submitter recorded final intent; awaiting human dual-control approval before kaggle.competitions.submit.',
      };
    };

    return {
      'Competition Discoverer': discovererSeed,
      'Approach Ideator': strategistAgenticWithHandoff,
      'Kernel Author': noop,
      'Submission Validator': opts.db ? validatorAgentic : noop,
      'Competition Submitter': submitter,
      'Leaderboard Observer': opts.db ? observerAgentic : noop,
    };
  }

  // ── DETERMINISTIC MODE (no LLM, DB-driven) ───────────────
  // Each iteration resolves the matching playbook by competition slug and
  // pushes the playbook's solver template with the strategy preset for this
  // iteration substituted in. If no playbook matches, the implementer logs
  // a notice and the pipeline ends without a push.

  // ── Discoverer ────────────────────────────────────────────
  const discoverer: TaskHandler = async (_action, context) => {
    const creds = resolveCreds(opts);
    log(`Discoverer fetching competitions...`);
    const opDefaults = await getOpDefaults();
    const comps = await adapter.listCompetitions(creds, { page: 1 });
    const top = comps.slice(0, opDefaults.topNDeterministic);
    log(`Discoverer found ${comps.length} competitions; forwarding top ${top.length} to strategist`);
    const summary = top
      .map((c: KaggleCompetition) => `- ${c.id} | ${c.title} | metric=${c.evaluationMetric ?? 'n/a'} | deadline=${c.deadline ?? 'n/a'}`)
      .join('\n');
    const body = JSON.stringify({ competitions: top }, null, 2);
    const subject = `Discovered ${top.length} candidate competitions`;
    await emitToNextAgent(context, 'strategist', subject, body, 'kaggle.discovery.candidates');
    return {
      completed: true,
      summaryProse: `Discovered ${comps.length} competitions; forwarded ${top.length} to strategist:\n${summary}`,
    } satisfies TaskHandlerResult;
  };

  // ── Strategist (deterministic) ────────────────────────────
  // Two entry shapes:
  //   1. From Discoverer: { competitions: [...] } → start iteration 1.
  //   2. From Validator (feedback): { competitionId, iteration, history, ... } → next iteration.
  const strategist: TaskHandler = async (_action, context) => {
    const inbound = await loadInboundTask(context);
    if (!inbound) return { completed: true, summaryProse: 'Strategist had no inbound payload; skipped.' };

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(inbound.body) as Record<string, unknown>;
    } catch {
      /* ignore */
    }

    // Branch 1: discovery payload → start iteration 1.
    if (Array.isArray((parsed as { competitions?: unknown }).competitions)) {
      const comps = (parsed as { competitions: KaggleCompetition[] }).competitions;
      const comp = comps[0];
      if (!comp) return { completed: true, summaryProse: 'Strategist: empty competition list.' };
      const slug = competitionSlugFrom(comp.id);
      const playbook = await tryResolvePlaybook(opts.playbookResolver, slug, 0, {}, log);
      const maxIterations = playbook?.config.maxIterations ?? opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
      const presetLabel = playbook?.config.strategyPresets?.[0]?.label ?? 'default';
      const approach = {
        competitionId: comp.id,
        title: comp.title,
        metric: comp.evaluationMetric ?? 'unknown',
        iteration: 1,
        maxIterations,
        playbookId: playbook?.skillId ?? null,
        playbookName: playbook?.name ?? null,
        strategyLabel: presetLabel,
        history: [] as Array<{ iteration: number; label: string; status: string }>,
      };
      await emitToNextAgent(
        context,
        'implementer',
        `Approach plan iteration 1 for ${comp.id}`,
        JSON.stringify(approach, null, 2),
        'kaggle.strategy.approach',
      );
      return {
        completed: true,
        summaryProse: `Strategist seeded iteration 1 for ${comp.id} with playbook=${playbook?.name ?? 'none'} preset=${presetLabel}; forwarded to implementer.`,
      };
    }

    // Branch 2: feedback from validator → mutate or finish.
    const competitionId = (parsed['competitionId'] as string) ?? 'unknown';
    const lastIteration = Number(parsed['iteration'] ?? 0);
    const lastStatus = (parsed['kernelStatus'] as string) ?? 'unknown';
    const history = (parsed['history'] as Array<{ iteration: number; label: string; status: string }>) ?? [];
    const slug = competitionSlugFrom(competitionId);
    const playbook = await tryResolvePlaybook(opts.playbookResolver, slug, 0, {}, log);
    const maxIterations =
      Number(parsed['maxIterations']) || playbook?.config.maxIterations || opts.maxIterations || DEFAULT_MAX_ITERATIONS;
    const nextIteration = lastIteration + 1;
    if (nextIteration > maxIterations) {
      log(`Strategist: max iterations reached (${maxIterations}); finishing.`);
      const finalPayload = { ...parsed, done: true };
      await emitToNextAgent(
        context,
        'validator',
        `Iteration loop complete for ${competitionId}`,
        JSON.stringify(finalPayload, null, 2),
        'kaggle.strategy.done',
      );
      return {
        completed: true,
        summaryProse: `Strategist completed ${maxIterations}-iteration loop for ${competitionId}; final status=${lastStatus}.`,
      };
    }
    const presets = playbook?.config.strategyPresets ?? [];
    const presetIdx = presets.length > 0 ? (nextIteration - 1) % presets.length : 0;
    const presetLabel = presets[presetIdx]?.label ?? `iteration-${nextIteration}`;
    const next = {
      competitionId,
      title: parsed['title'] ?? '',
      metric: parsed['metric'] ?? 'unknown',
      iteration: nextIteration,
      maxIterations,
      playbookId: playbook?.skillId ?? null,
      playbookName: playbook?.name ?? null,
      strategyLabel: presetLabel,
      history,
    };
    await emitToNextAgent(
      context,
      'implementer',
      `Approach plan iteration ${nextIteration} for ${competitionId}`,
      JSON.stringify(next, null, 2),
      'kaggle.strategy.approach',
    );
    return {
      completed: true,
      summaryProse: `Strategist mutated to preset ${presetLabel} for iteration ${nextIteration}; forwarded to implementer.`,
    };
  };

  // ── Implementer (Kernel Author) ───────────────────────────
  // Resolves the playbook by competition slug, asks it for the rendered
  // solver template (preset variables already substituted), pushes it.
  const implementer: TaskHandler = async (_action, context) => {
    const inbound = await loadInboundTask(context);
    if (!inbound) return { completed: true, summaryProse: 'Implementer had no inbound payload; skipped.' };

    let approach: Record<string, unknown> = {};
    try {
      approach = JSON.parse(inbound.body) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    const competitionSlug = competitionSlugFrom((approach['competitionId'] as string) ?? '');
    const iteration = Number(approach['iteration'] ?? 1);
    const strategyLabel = (approach['strategyLabel'] as string) ?? 'baseline';
    const history = (approach['history'] as Array<{ iteration: number; label: string; status: string }>) ?? [];

    // Resolve the playbook with the iteration's preset baked in.
    const playbook = await tryResolvePlaybook(
      opts.playbookResolver,
      competitionSlug,
      Math.max(0, iteration - 1),
      {},
      log,
    );

    if (!playbook) {
      const reason = `No playbook resolver configured or no playbook matched competition slug "${competitionSlug}". Skipping kernel push. Configure a playbook resolver and seed a kaggle_playbook skill that matches this slug.`;
      log(reason);
      const payload = {
        competitionId: competitionSlug,
        iteration,
        strategyLabel,
        kernelStatus: 'skipped',
        failureMessage: reason,
        history: [...history, { iteration, label: strategyLabel, status: 'skipped' }],
      };
      await emitToNextAgent(
        context,
        'validator',
        `Iteration ${iteration} skipped (no playbook) for ${competitionSlug}`,
        JSON.stringify(payload, null, 2),
        'kaggle.implementer.kernel-result',
      );
      return { completed: true, summaryProse: reason };
    }

    if (!playbook.solverTemplate) {
      const reason = `Playbook ${playbook.name} matched but provides no solverTemplate (set examples.solverTemplateFragmentKey to a prompt fragment). Skipping push.`;
      log(reason);
      const payload = {
        competitionId: competitionSlug,
        iteration,
        strategyLabel,
        playbookId: playbook.skillId,
        kernelStatus: 'skipped',
        failureMessage: reason,
        history: [...history, { iteration, label: strategyLabel, status: 'skipped' }],
      };
      await emitToNextAgent(
        context,
        'validator',
        `Iteration ${iteration} skipped (no solverTemplate) for ${competitionSlug}`,
        JSON.stringify(payload, null, 2),
        'kaggle.implementer.kernel-result',
      );
      return { completed: true, summaryProse: reason };
    }

    const creds = resolveCreds(opts);
    const ownerSlug = creds.username.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const stamp = Date.now().toString(36);
    const kernelSlug = `wi-${competitionSlug}-it${iteration}-${stamp}`.slice(0, 60);
    const fullKernelSlug = `${ownerSlug}/${kernelSlug}`;
    const kernelTitle = `wi ${competitionSlug} it${iteration} ${stamp}`.slice(0, 50);
    const scriptSource = playbook.solverTemplate;

    log(
      `Implementer pushing kernel ${fullKernelSlug} (iteration ${iteration}, preset ${strategyLabel}, ` +
        `playbook ${playbook.name})`,
    );
    let kernelRef = '';
    let kernelUrl = '';
    let pushStatus = 'unknown';
    let pushError: string | null = null;
    try {
      const pushResult = await adapter.pushKernel(creds, {
        slug: fullKernelSlug,
        title: kernelTitle,
        source: scriptSource,
        kernelType: 'script',
        language: 'python',
        isPrivate: true,
        enableInternet: false,
        enableGpu: false,
        competitionSource: competitionSlug,
      });
      kernelRef = normalizeKernelRef(pushResult.ref, pushResult.url);
      kernelUrl = pushResult.url;
      pushStatus = pushResult.status;
      pushError = pushResult.errorMessage;
      log(`Push ok ref=${kernelRef} url=${kernelUrl} status=${pushStatus}`);
    } catch (err) {
      pushError = err instanceof Error ? err.message : String(err);
      log(`Push failed: ${pushError}`);
    }

    let runStatus = pushStatus;
    let failureMessage: string | null = pushError;
    let logExcerpt = '';
    let outputFiles: string[] = [];
    if (kernelRef && !pushError) {
      const opDefaults = await getOpDefaults();
      // Per-playbook overrides win over catch-all defaults.
      const pollIntervalMs = (playbook.config.pollIntervalSec ?? 0) > 0
        ? (playbook.config.pollIntervalSec as number) * 1000
        : opDefaults.pollIntervalMs;
      const pollTimeoutMs = (playbook.config.pollTimeoutSec ?? 0) > 0
        ? (playbook.config.pollTimeoutSec as number) * 1000
        : opDefaults.pollTimeoutMs;
      const polled = await pollKernelUntilTerminal(
        adapter,
        creds,
        kernelRef,
        (m) => log(m),
        pollIntervalMs,
        pollTimeoutMs,
      );
      runStatus = polled.status;
      failureMessage = polled.failureMessage ?? failureMessage;
      logExcerpt = polled.logExcerpt;
      outputFiles = polled.outputFiles;
    }

    const updatedHistory = [...history, { iteration, label: strategyLabel, status: runStatus }];
    const payload = {
      competitionId: competitionSlug,
      title: approach['title'] ?? '',
      metric: approach['metric'] ?? 'unknown',
      iteration,
      maxIterations: Number(approach['maxIterations']) || playbook.config.maxIterations || DEFAULT_MAX_ITERATIONS,
      playbookId: playbook.skillId,
      playbookName: playbook.name,
      strategyLabel,
      kernelRef,
      kernelUrl,
      kernelStatus: runStatus,
      failureMessage,
      outputFiles,
      logExcerpt,
      history: updatedHistory,
    };
    await emitToNextAgent(
      context,
      'validator',
      `Iteration ${iteration} kernel result for ${competitionSlug}`,
      JSON.stringify(payload, null, 2),
      'kaggle.implementer.kernel-result',
    );
    return {
      completed: true,
      summaryProse: `Iteration ${iteration} kernel ${kernelRef || '(push failed)'} status=${runStatus}; forwarded to validator.`,
    };
  };

  // ── Validator ─────────────────────────────────────────────
  const validator: TaskHandler = async (_action, context) => {
    const inbound = await loadInboundTask(context);
    if (!inbound) return { completed: true, summaryProse: 'Validator had no inbound payload; skipped.' };

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(inbound.body) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    const iteration = Number(parsed['iteration'] ?? 0);
    const maxIterations = Number(parsed['maxIterations'] ?? DEFAULT_MAX_ITERATIONS);
    const done = parsed['done'] === true;
    const status = (parsed['kernelStatus'] as string) ?? 'unknown';
    const competitionId = (parsed['competitionId'] as string) ?? 'unknown';
    const hasSubmissionFile =
      Array.isArray(parsed['outputFiles']) &&
      (parsed['outputFiles'] as string[]).some((f) => f === 'submission.json' || f === 'submission.csv');

    // Phase K7d — persist a kaggle_validation_results row when db wired.
    if (opts.db && competitionId !== 'unknown') {
      const outputFiles = Array.isArray(parsed['outputFiles']) ? (parsed['outputFiles'] as string[]) : [];
      const kernelRef = (parsed['kernelRef'] as string | null | undefined) ?? null;
      const cvScores = parsed['cvScores'] as CvScoresArtifact | undefined ?? null;
      const runId = (parsed['runId'] as string | undefined) ?? `kgl-run-${randomUUID().slice(0, 8)}`;
      try {
        const creds = resolveCreds(opts);
        const result = await runSubmissionValidation({
          db: opts.db,
          adapter,
          credentials: creds,
          runId,
          competitionRef: competitionId,
          tenantId: opts.tenantId ?? null,
          kernelRef,
          outputFiles,
          cvScores,
        });
        log(`validator(persist): verdict=${result.verdict} rubric=${result.rubric.id} violations=${result.violations.length}`);
      } catch (err) {
        log(`validator(persist): failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (done || iteration >= maxIterations) {
      const subject = `Validated final payload for ${competitionId} after ${iteration} iteration(s)`;
      await emitToNextAgent(context, 'submitter', subject, inbound.body, 'kaggle.validation.final');
      return {
        completed: true,
        summaryProse: `Validator finalized after iteration ${iteration} (status=${status}, submission=${hasSubmissionFile}); forwarded to submitter.`,
      };
    }

    // Mid-iteration: bounce back to strategist for mutation.
    const subject = `Iteration ${iteration} feedback for ${competitionId}`;
    await emitToNextAgent(context, 'strategist', subject, inbound.body, 'kaggle.validation.iteration');
    return {
      completed: true,
      summaryProse: `Validator forwarded iteration ${iteration} feedback to strategist (status=${status}, submission=${hasSubmissionFile}).`,
    };
  };

  // ── Submitter ─────────────────────────────────────────────
  const submitter: TaskHandler = async (_a, context) => {
    const inbound = await loadInboundTask(context);
    log(
      `Submitter received payload (${inbound?.body.length ?? 0} bytes). ` +
        `Real submission requires dual-control approval; recording intent only.`,
    );
    return {
      completed: true,
      summaryProse: `Submitter recorded submission intent; awaiting human dual-control approval before kaggle.competitions.submit is invoked.`,
    };
  };

  // ── Observer ──────────────────────────────────────────────
  const observer: TaskHandler = async (_a, context) => {
    if (opts.db) {
      const inbound = await loadInboundTask(context);
      const parsed = parseInboundJson(inbound?.body);
      const competitionRef = (parsed['competitionId'] as string | undefined) ?? (parsed['competitionRef'] as string | undefined);
      if (competitionRef) {
        try {
          const creds = resolveCreds(opts);
          const result = await observeLeaderboardOnce({
            db: opts.db,
            adapter,
            credentials: creds,
            runId: (parsed['runId'] as string | undefined) ?? null,
            competitionRef,
            submissionRef: (parsed['submissionRef'] as string | null | undefined) ?? null,
            cvScore: typeof parsed['cvScore'] === 'number' ? (parsed['cvScore'] as number) : null,
          });
          log(`observer(persist): observed=${result.observed} public=${result.publicScore} delta=${result.cvLbDelta}`);
          return {
            completed: true,
            summaryProse: result.observed
              ? `Observer: public_score=${result.publicScore} status=${result.rawStatus} delta=${result.cvLbDelta}`
              : 'Observer: no submissions yet.',
          };
        } catch (err) {
          log(`observer(persist): failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    log('Observer tick: nothing to poll yet (no submitted entries).');
    return {
      completed: true,
      summaryProse: 'Observer tick complete; no leaderboard activity to report.',
    };
  };

  return {
    'Competition Discoverer': discoverer,
    'Approach Ideator': strategist,
    'Kernel Author': implementer,
    'Submission Validator': validator,
    'Competition Submitter': submitter,
    'Leaderboard Observer': observer,
  };
}

// Re-export the slug helper for callers that need to extract slugs from
// inbound text (e.g. examples or downstream tools).
export { extractCompetitionSlugFromText };
