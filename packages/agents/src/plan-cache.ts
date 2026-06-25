/**
 * @weaveintel/agents — Agentic Plan Caching (Phase 8, G‑10; arXiv:2506.14852).
 *
 * Repetitive agent/supervisor tasks tend to follow the SAME structural plan
 * (decompose → delegate/tool → synthesize). Re-deriving that plan from scratch
 * on every similar task burns planning tokens and latency. This module captures
 * a *structured plan template* from a finished run, stores it keyed by the task
 * goal (semantically), and — for a SIMILAR future goal — returns the template so
 * the caller can inject it as planning guidance. The agent still EXECUTES with
 * the new task's parameters (every tool call re-runs through the host's normal
 * guardrail/scope/policy pipeline) — only the plan *derivation* is short-cut, so
 * a cached plan can never bypass authorization or replay a stale answer.
 *
 * Storage-agnostic: it rides on a `SemanticCache` (the same embedding infra the
 * response cache uses) so "similar task" = "nearby embedding". Reusable from any
 * app that runs `@weaveintel/agents`.
 */
import type { SemanticCache, AgentStep } from '@weaveintel/core';

/** A distilled, reusable plan template extracted from a finished agent run. */
export interface AgentPlan {
  /** The task this plan solved (truncated goal) — for human/debug context. */
  objective: string;
  /** Ordered, compact step descriptors (e.g. `tool:web_search(query)`, `delegate→researcher`). */
  steps: string[];
  /** Distinct worker agents the plan delegated to. */
  workers: string[];
  /** Distinct tools the plan invoked. */
  tools: string[];
  /** Number of execution steps (for a min-steps reuse gate). */
  stepCount: number;
  /** ISO timestamp the plan was distilled (stamped by the caller; optional). */
  createdAt?: string;
}

export interface AgentPlanCacheMetrics {
  onHit(): void;
  onMiss(): void;
  onStore(): void;
  snapshot(): { hits: number; misses: number; stores: number; hitRate: number };
  reset(): void;
}

export function createPlanCacheMetrics(): AgentPlanCacheMetrics {
  let hits = 0, misses = 0, stores = 0;
  return {
    onHit() { hits++; },
    onMiss() { misses++; },
    onStore() { stores++; },
    snapshot() { const l = hits + misses; return { hits, misses, stores, hitRate: l > 0 ? hits / l : 0 }; },
    reset() { hits = misses = stores = 0; },
  };
}

export interface AgentPlanCacheOptions {
  /** Embedding-similarity cache the plans are stored in / matched against. */
  semanticCache: SemanticCache;
  /** Default similarity threshold for a plan match. Default 0.85. */
  threshold?: number;
  /** Default TTL for a stored plan. Default 24h. */
  ttlMs?: number;
  /** Max characters of step content kept per step (keeps templates compact + secret-light). Default 80. */
  maxStepChars?: number;
  /** Max steps retained in a template. Default 24. */
  maxSteps?: number;
  /** Optional metrics sink. */
  metrics?: AgentPlanCacheMetrics;
}

export interface PlanScopeOptions { scope?: string; threshold?: number }
export interface PlanStoreOptions { scope?: string; ttlMs?: number }

export interface AgentPlanCache {
  /** Find a reusable plan for a semantically-similar goal. Null on miss. */
  lookup(goal: string, opts?: PlanScopeOptions): Promise<AgentPlan | null>;
  /** Persist a distilled plan keyed by the goal (scoped). Best-effort. */
  store(goal: string, plan: AgentPlan, opts?: PlanStoreOptions): Promise<void>;
  /** Distill a finished run's steps into a compact, reusable plan template. */
  distill(run: { output: string; steps: ReadonlyArray<AgentStep> }, goal: string): AgentPlan;
  /** Render a plan as a planning-guidance block to inject ahead of a goal. */
  renderGuidance(plan: AgentPlan): string;
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export function createAgentPlanCache(opts: AgentPlanCacheOptions): AgentPlanCache {
  const defaultThreshold = opts.threshold ?? 0.85;
  const defaultTtl = opts.ttlMs ?? 24 * 60 * 60 * 1000;
  const maxStepChars = opts.maxStepChars ?? 80;
  const maxSteps = opts.maxSteps ?? 24;
  const metrics = opts.metrics;

  function isPlan(v: unknown): v is AgentPlan {
    return !!v && typeof v === 'object' && Array.isArray((v as AgentPlan).steps) && typeof (v as AgentPlan).stepCount === 'number';
  }

  return {
    distill(run, goal) {
      const steps: string[] = [];
      const workers = new Set<string>();
      const tools = new Set<string>();
      for (const s of run.steps) {
        if (steps.length >= maxSteps) break;
        if (s.type === 'delegation' && s.delegation) {
          workers.add(s.delegation.agent);
          steps.push(`delegate→${s.delegation.agent}: ${truncate(s.delegation.goal, maxStepChars)}`);
        } else if (s.type === 'tool_call' && s.toolCall) {
          tools.add(s.toolCall.name);
          const argKeys = Object.keys(s.toolCall.arguments ?? {}).join(', ');
          steps.push(`tool:${s.toolCall.name}(${argKeys})`);
        } else if (s.type === 'thinking') {
          steps.push(`think: ${truncate(s.content, maxStepChars)}`);
        } else if (s.type === 'response') {
          steps.push('respond');
        } else {
          steps.push(String(s.type));
        }
      }
      return {
        objective: truncate(goal, 200),
        steps,
        workers: [...workers],
        tools: [...tools],
        stepCount: run.steps.length,
      };
    },

    renderGuidance(plan) {
      const lines: string[] = [];
      lines.push('[Reference plan — a similar task was solved before with the approach below. ADAPT it to the CURRENT request: re-derive all parameters from the current task and verify each step still applies; do not reuse stale values or skip required checks.]');
      if (plan.objective) lines.push(`Previously solved: ${plan.objective}`);
      if (plan.steps.length) {
        lines.push('Suggested step outline:');
        plan.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
      }
      if (plan.workers.length) lines.push(`Workers previously used: ${plan.workers.join(', ')}`);
      if (plan.tools.length) lines.push(`Tools previously used: ${plan.tools.join(', ')}`);
      return lines.join('\n');
    },

    async lookup(goal, o) {
      const scope = o?.scope;
      const threshold = o?.threshold ?? defaultThreshold;
      const hit = await opts.semanticCache.find(goal, { ...(scope ? { scope } : {}), threshold }).catch(() => null);
      const plan = hit?.response;
      if (isPlan(plan)) { metrics?.onHit(); return plan; }
      metrics?.onMiss();
      return null;
    },

    async store(goal, plan, o) {
      const scope = o?.scope;
      const ttlMs = o?.ttlMs ?? defaultTtl;
      await opts.semanticCache.store(goal, plan, { ...(scope ? { scope } : {}), ttlMs }).then(() => metrics?.onStore()).catch(() => { /* best-effort */ });
    },
  };
}
