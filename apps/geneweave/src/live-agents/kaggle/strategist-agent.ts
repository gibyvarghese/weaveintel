/**
 * Kaggle Strategist agent — long-running, LLM-driven, ReAct loop.
 *
 * Built on top of `@weaveintel/agents` `weaveAgent` (the same ReAct/tool-calling
 * loop used elsewhere in the platform), but wrapped in a live-agents
 * `TaskHandler` so that:
 *
 *   - state is persisted in `la_entities` between ticks (mesh, agent, backlog
 *     items, messages, contracts, run logs)
 *   - the heartbeat scheduler decides when the agent runs
 *   - human-in-the-loop gates and audit trails apply uniformly
 *
 * THIS FILE INTENTIONALLY CONTAINS NO COMPETITION-SPECIFIC TEXT.
 * The strategist's system prompt is loaded at runtime from a GeneWeave DB
 * playbook (resolved by `playbookResolver`) keyed off the inbound competition
 * slug. ARC-AGI-3 facts, ladders, solver templates, and so on are seeded into
 * the DB (see `playbook-seed.ts`) and editable via the admin UI.
 *
 * Submission to Kaggle is intentionally NOT exposed as a tool — submission is
 * a human-approved Promotion in the live-agents framework.
 */

import { weaveAgent } from '@weaveintel/agents';
import { weaveContext } from '@weaveintel/core';
import type { ExecutionContext, Model } from '@weaveintel/core';
import type {
  ActionExecutionContext,
  AttentionAction,
  TaskHandler,
  TaskHandlerResult,
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
}

/** Last-resort prompt — used only when neither playbookResolver nor
 *  fallbackGoalText is provided. Deliberately minimal; production wires the
 *  DB resolver. */
const HARDCODED_FALLBACK_GOAL = `You are a Kaggle research agent. The operator has not configured a playbook for this competition. List active competitions, pick a tractable one, push a small scout kernel that explores /kaggle/input and prints AGENT_RESULT, and report back. Do not submit.`;

export function createKaggleStrategistHandler(opts: KaggleStrategistAgentOptions): TaskHandler {
  const adapter = opts.adapter ?? liveKaggleAdapter;
  const credentials = opts.credentials ?? resolveCredentialsFromEnv();
  const log = opts.log ?? ((m: string) => console.log(`[kaggle-strategist] ${m}`));
  const maxSteps = opts.maxSteps ?? 90;

  return async (
    _action: AttentionAction & { type: 'StartTask' | 'ContinueTask' },
    context: ActionExecutionContext,
    execCtx: ExecutionContext,
  ): Promise<TaskHandlerResult> => {
    log(`agent ${context.agent.id} starting ReAct loop (maxSteps=${maxSteps})`);

    // Pull any inbound context (e.g. seed message specifying which competition to focus on).
    const inbound = await loadLatestInboundTask(context);
    const inboundBody = inbound?.body?.trim() ?? '';
    const competitionSlug = extractCompetitionSlugFromText(inboundBody);
    log(
      `inbound subject="${inbound?.subject ?? '(none)'}" bodyLen=${inboundBody.length} ` +
        `competitionSlug="${competitionSlug || '(none)'}"`,
    );

    // Resolve system prompt from the DB playbook for this competition slug.
    let systemPrompt = opts.fallbackGoalText ?? HARDCODED_FALLBACK_GOAL;
    let playbookSummary = 'fallback (no resolver)';
    if (opts.playbookResolver) {
      try {
        const playbook = await opts.playbookResolver(competitionSlug);
        if (playbook) {
          systemPrompt = playbook.systemPrompt;
          playbookSummary = `${playbook.name} (matched=${playbook.matchedPattern}, shape=${playbook.config.shape ?? 'unknown'})`;
        } else if (opts.fallbackGoalText) {
          playbookSummary = 'fallback (no playbook matched)';
        }
      } catch (err) {
        log(`!! playbookResolver threw: ${err instanceof Error ? err.message : String(err)} — using fallback prompt`);
      }
    }
    log(`playbook=${playbookSummary} promptBytes=${systemPrompt.length}`);

    const tools = createKaggleTools({ adapter, credentials });
    const agent = weaveAgent({
      name: 'kaggle-strategist',
      model: opts.model,
      tools,
      systemPrompt,
      maxSteps,
    });

    const userGoal = inboundBody
      ? `Seed message from operator:\n${inboundBody}\n\nProceed per the workflow.`
      : `No specific competition was named. Pick the most tractable active competition and proceed.`;

    const ctx = execCtx ?? weaveContext({ userId: `live-agent:${context.agent.id}` });
    let result: { status: string; steps: ReadonlyArray<{ type: string; content?: string }> };
    try {
      result = await agent.run(ctx, {
        goal: 'Run one Kaggle research iteration cycle',
        messages: [{ role: 'user', content: userGoal }],
      });
    } catch (err) {
      const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      log(`!! agent.run threw: ${msg}`);
      // Detect Anthropic rate-limit and back off long enough for the per-minute
      // window to drain. Without this, the heartbeat re-dispatches every tick
      // and we burn the entire TPM budget on retries before any tool call lands.
      const text = err instanceof Error ? err.message : String(err);
      if (/rate limit/i.test(text) || /\b429\b/.test(text)) {
        log('rate-limit detected; sleeping 65s before next attempt');
        await new Promise((resolve) => setTimeout(resolve, 65_000));
      }
      throw err;
    }

    const summary = summarizeRun(result);
    log(`agent finished: status=${result.status} steps=${result.steps.length}`);
    log(summary);

    return {
      completed: true,
      summaryProse: summary,
    };
  };
}

function resolveCredentialsFromEnv(): KaggleCredentials {
  const username = process.env['KAGGLE_USERNAME'];
  const key = process.env['KAGGLE_KEY'];
  if (!username || !key) {
    throw new Error('KAGGLE_USERNAME and KAGGLE_KEY must be set in env for the Kaggle strategist agent.');
  }
  return { username, key };
}

async function loadLatestInboundTask(
  context: ActionExecutionContext,
): Promise<{ subject: string; body: string } | null> {
  const inbox = await context.stateStore.listMessagesForRecipient('AGENT', context.agent.id);
  const tasks = inbox
    .filter((m) => m.kind === 'TASK')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const m = tasks[0];
  return m ? { subject: m.subject, body: m.body } : null;
}

interface ToolCallStep {
  type: string;
  content?: string;
  toolCall?: { name: string; arguments?: Record<string, unknown>; result?: string };
}

function summarizeRun(result: { status: string; steps: ReadonlyArray<ToolCallStep> }): string {
  const last = [...result.steps].reverse().find((s) => s.type === 'response');
  const finalText = last?.content ?? '(no final response)';
  const toolSteps = result.steps.filter((s) => s.type === 'tool_call' && s.toolCall);
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
