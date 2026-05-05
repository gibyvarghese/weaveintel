/** Kaggle Strategist — agentic LLM ReAct loop wrapper + deterministic preset rotator. */
import type { TaskHandler } from '@weaveintel/live-agents';
import type { KaggleCompetition } from '@weaveintel/tools-kaggle';
import { createKaggleStrategistHandler } from '../strategist-agent.js';
import {
  competitionSlugFrom,
  emitToNextAgent,
  loadInboundTask,
  resolveCreds,
  tryResolvePlaybook,
  DEFAULT_MAX_ITERATIONS,
  type SharedHandlerContext,
} from './_shared.js';

/** Agentic strategist — wraps the package-level agentic handler and emits
 *  its final summary to the submitter so the pipeline-completion check still fires.
 *
 *  Per-tick model routing (Phase 5): the inner ReAct handler is rebuilt on
 *  every invocation with the model `opts.modelResolver` picks for the
 *  strategist's reasoning task. This lets the framework rotate models based
 *  on health/cost on every tick — when one provider rate-limits or runs out
 *  of credit, the next tick picks a different one. When `opts.plannerModel`
 *  is set (e.g. tests, single-model deployments) it is used as a static
 *  fallback whenever the resolver returns `undefined` or throws. */
export function createStrategistAgenticWithHandoff(ctx: SharedHandlerContext): TaskHandler {
  const { opts, adapter, log } = ctx;
  if (!opts.plannerModel && !opts.modelResolver) {
    throw new Error(
      'createStrategistAgenticWithHandoff requires opts.plannerModel or opts.modelResolver',
    );
  }
  const creds = resolveCreds(opts);
  const maxSteps = opts.maxIterations ? Math.max(opts.maxIterations * 12, 40) : 60;

  // Build the inner handler factory once; the per-call wrapper resolves the
  // model fresh each tick so SmartModelRouter can rotate based on current
  // provider health.
  const buildInner = (model: import('@weaveintel/core').Model) =>
    createKaggleStrategistHandler({
      model,
      adapter,
      credentials: creds,
      maxSteps,
      log,
      playbookResolver: opts.playbookResolver,
      ...(opts.policy ? { policy: opts.policy } : {}),
    });

  // Pre-built fallback inner handler (used when no per-tick resolver).
  const staticInner = opts.plannerModel ? buildInner(opts.plannerModel) : null;

  return async (action, context, execCtx) => {
    let inner = staticInner;
    if (opts.modelResolver) {
      try {
        const routed = await opts.modelResolver.resolve({
          role: 'strategist',
          agentId: context.agent.id,
          meshId: context.agent.meshId,
          capability: { task: 'reasoning' },
        });
        if (routed) {
          inner = buildInner(routed);
          // Log the per-tick selection so operators can see SmartModelRouter
          // rotating models across ticks (especially useful when a provider
          // rate-limits and routing skips it on the next tick).
          const routedId =
            (routed as unknown as { id?: string }).id ??
            (routed as unknown as { modelId?: string }).modelId ??
            'unknown';
          log(`per-tick model resolved → ${routedId}`);
        }
      } catch (err) {
        log(
          `!! per-tick modelResolver failed; using static planner: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!inner) {
      return { completed: true, summaryProse: 'Strategist had no model available; skipped.' };
    }
    const result = await inner(action, context, execCtx);
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
}

/** Deterministic strategist — branches on inbound shape:
 *   1. discovery payload `{ competitions: [...] }` → start iteration 1
 *   2. validator feedback `{ competitionId, iteration, history, ... }` → mutate or finish */
export function createStrategistDeterministic(ctx: SharedHandlerContext): TaskHandler {
  const { opts, log } = ctx;
  return async (_action, context) => {
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
}
