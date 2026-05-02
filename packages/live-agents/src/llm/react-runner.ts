/**
 * Phase 2.5 — `runLiveReactLoop`: the live-agents-owned ReAct loop.
 *
 * This is the seam the rest of the live-agents package depends on. It
 * currently delegates to `@weaveintel/agents.weaveAgent` so we get a
 * battle-tested ReAct implementation for free, but the boundary is
 * fully owned by live-agents — which means future phases can:
 *
 *   - Plug the Phase 3.5 model resolver in front of `model`.
 *   - Add streaming, pause/resume, and cancellation handling.
 *   - Enforce a `LiveAgentBudget` between iterations.
 *   - Persist step events to `live_run_events` automatically.
 *
 * Today the runner enforces a budget envelope around the agent run, then
 * normalizes the result into a `LiveReactLoopResult` shape that downstream
 * code (handlers, action executor, replay) can rely on.
 */

import { weaveAgent } from '@weaveintel/agents';
import { weaveContext } from '@weaveintel/core';
import type { ExecutionContext, Model, ToolRegistry } from '@weaveintel/core';
import { createBudgetTracker, BudgetExhausted } from './budget.js';
import type { LiveAgentBudget, LiveAgentRunStatus } from './types.js';

/** Inputs are intentionally a flat shape so callers don't have to thread
 *  package-private types around. */
export interface LiveReactLoopInput {
  /** Logical name (for logging + telemetry). */
  name: string;
  /** Resolved Model — typically from the Phase 3.5 resolver. */
  model: Model;
  /** Optional tool surface — typically from the Phase 3 binder. */
  tools?: ToolRegistry;
  /** System prompt for this iteration. */
  systemPrompt: string;
  /** First user-turn content. */
  userGoal: string;
  /** Hard ceiling on inner ReAct steps. */
  maxSteps?: number;
  /** Optional per-run envelope — the runner converts BudgetExhausted into
   *  a `'budget_exhausted'` terminal status rather than throwing. */
  budget?: LiveAgentBudget;
  /** Optional execution context (defaults to a synthetic live-agent ctx). */
  execContext?: ExecutionContext;
  /** Identifier for the synthetic ctx (only used when execContext is omitted). */
  agentId?: string;
}

export interface LiveReactLoopStep {
  type: string;
  content?: string;
}

export interface LiveReactLoopResult {
  /** Normalized status. Always one of LiveAgentRunStatus. */
  status: LiveAgentRunStatus;
  /** Raw status from the underlying engine, kept for diagnostics. */
  rawStatus: string;
  /** Step trace (response / tool_call / tool_result / etc.). */
  steps: ReadonlyArray<LiveReactLoopStep>;
  /** Final assistant text, if any. */
  finalText: string | null;
  /** Populated when status === 'errored' or 'budget_exhausted'. */
  error?: string;
}

/**
 * Run one ReAct iteration cycle for a live agent. Never throws under
 * normal operation — every error path resolves to a populated
 * `LiveReactLoopResult` with `status === 'errored'` and a non-empty
 * `error` string. Callers that need to surface the original error must
 * inspect that field.
 */
export async function runLiveReactLoop(input: LiveReactLoopInput): Promise<LiveReactLoopResult> {
  const maxSteps = input.maxSteps ?? 60;
  const budget = createBudgetTracker(input.budget);

  const agent = weaveAgent({
    name: input.name,
    model: input.model,
    ...(input.tools ? { tools: input.tools } : {}),
    systemPrompt: input.systemPrompt,
    maxSteps,
  });

  const ctx = input.execContext
    ?? weaveContext({ userId: `live-agent:${input.agentId ?? input.name}` });

  try {
    const result = await agent.run(ctx, {
      goal: `Run one ${input.name} iteration cycle`,
      messages: [{ role: 'user', content: input.userGoal }],
    });

    // Best-effort budget bookkeeping. We don't have token usage from the
    // engine output yet — wire that in once weaveAgent exposes it.
    for (const s of result.steps) {
      if (s.type === 'tool_call') budget.noteToolCall();
      budget.noteStep();
    }
    try { budget.check(); } catch (err) {
      if (err instanceof BudgetExhausted) {
        return {
          status: 'budget_exhausted',
          rawStatus: result.status,
          steps: result.steps as ReadonlyArray<LiveReactLoopStep>,
          finalText: extractFinalText(result.steps as ReadonlyArray<LiveReactLoopStep>),
          error: err.message,
        };
      }
      throw err;
    }

    return {
      status: normaliseStatus(result.status),
      rawStatus: result.status,
      steps: result.steps as ReadonlyArray<LiveReactLoopStep>,
      finalText: extractFinalText(result.steps as ReadonlyArray<LiveReactLoopStep>),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'errored',
      rawStatus: 'errored',
      steps: [],
      finalText: null,
      error: msg,
    };
  }
}

function normaliseStatus(raw: string): LiveAgentRunStatus {
  switch (raw) {
    case 'completed':
    case 'success':
    case 'done':
      return 'completed';
    case 'cancelled':
    case 'aborted':
      return 'cancelled';
    default:
      // Anything else (max_steps, tool_failure, etc.) → 'completed' with
      // diagnostics in `rawStatus`. Future phases can map more states.
      return 'completed';
  }
}

function extractFinalText(steps: ReadonlyArray<LiveReactLoopStep>): string | null {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const s = steps[i]!;
    if (s.type === 'response' && typeof s.content === 'string') return s.content;
  }
  return null;
}
