/**
 * GeneWeave chat — model routing and cache policy resolution
 *
 * Extracted from ChatEngine to keep chat.ts focused on orchestration.
 */

import type { CachePolicy, ModelHealth, OutputModality, RoutingToolDescriptor as ToolDescriptor } from '@weaveintel/core';
import { SmartModelRouter } from '@weaveintel/routing';
import type { ModelCostInfo, ModelQualityInfo } from '@weaveintel/routing';
import type { ModelCapabilityRow, TaskTypeInferenceHints } from '@weaveintel/core';
import type { TaskInferenceHintsMap } from '@weaveintel/routing';
import { resolvePolicy } from '@weaveintel/cache';
import { FALLBACK_PRICING } from './chat-runtime.js';
import type { DatabaseAdapter } from './db.js';
import { SqliteDecisionStore } from './sqlite-decision-store.js';

// ── Model routing ────────────────────────────────────────────

export interface RouteModelOpts {
  provider?: string;
  model?: string;
  /** Phase 2: explicit task key override (takes priority over inference). */
  taskType?: string;
  /** Phase 2: tools the agent will use (used for tool-pattern inference). */
  tools?: ToolDescriptor[];
  /** Phase 2: skill metadata for inference. */
  skill?: { key?: string; category?: string; tags?: string[] };
  /** Phase 2: user prompt text (used for keyword-based inference). */
  prompt?: string;
  /** Phase 2: agent default task type from agents.default_task_type. */
  agentDefaultTaskType?: string | null;
  /** Phase 2: required output modality for filtering. */
  outputModality?: OutputModality;
  /** Phase 2: per-call cost ceiling in USD. */
  maxCostPerCall?: number;
  /** Phase 2: trace correlation IDs. */
  tenantId?: string | null;
  agentId?: string | null;
  workflowStepId?: string | null;
}

/**
 * Select model + provider using the active routing policy from the DB.
 * Returns null if no enabled policy exists (caller falls back to default).
 */
export async function routeModel(
  db: DatabaseAdapter,
  candidates: Array<{ id: string; provider: string }>,
  healthList: ModelHealth[],
  opts?: RouteModelOpts,
): Promise<{ provider: string; modelId: string; taskKey?: string; inferenceSource?: string } | null> {
  try {
    const policies = await db.listRoutingPolicies();
    const active = policies.find(p => p.enabled);
    if (!active) return null;

    const routerCandidates = candidates.map(m => ({
      modelId: m.id,
      providerId: m.provider,
    }));

    if (routerCandidates.length === 0) return null;

    // Load pricing & quality from DB (falls back to hardcoded if DB is empty)
    const pricingRows = await db.listModelPricing();
    const pricingMap = new Map(pricingRows.filter(r => r.enabled).map(r => [`${r.provider}:${r.model_id}`, r]));

    // Cost data from DB model_pricing table
    const costs: ModelCostInfo[] = routerCandidates.map(c => {
      const row = pricingMap.get(`${c.providerId}:${c.modelId}`);
      const fb = FALLBACK_PRICING[c.modelId];
      return {
        modelId: c.modelId,
        providerId: c.providerId,
        inputCostPer1M: row ? row.input_cost_per_1m : fb ? fb.input : 10,
        outputCostPer1M: row ? row.output_cost_per_1m : fb ? fb.output : 30,
      };
    });

    // Quality scores from DB model_pricing table
    const qualities: ModelQualityInfo[] = routerCandidates.map(c => {
      const row = pricingMap.get(`${c.providerId}:${c.modelId}`);
      return {
        modelId: c.modelId,
        providerId: c.providerId,
        qualityScore: row ? row.quality_score : 0.7,
      };
    });

    // ── Phase 2: task-aware data ──────────────────────────────
    let capabilityRows: ModelCapabilityRow[] = [];
    const taskInferenceHints: TaskInferenceHintsMap = new Map();
    const modalityMap = new Map<string, OutputModality>();

    try {
      const taskTypes = await db.listTaskTypes();
      for (const t of taskTypes) {
        if (!t.enabled) continue;
        let raw: Record<string, unknown> = {};
        try { raw = JSON.parse(t.inference_hints) as Record<string, unknown>; } catch { /* ignore */ }
        // Normalize legacy seed shape: accept `keywords`/`tools`/`categories`/`tags`
        // as aliases for the spec field names.
        const hints: TaskTypeInferenceHints = {
          promptKeywords: (raw['promptKeywords'] as string[]) ?? (raw['keywords'] as string[]),
          toolPatterns: (raw['toolPatterns'] as string[]) ?? (raw['tools'] as string[]),
          skillCategories: (raw['skillCategories'] as string[]) ?? (raw['categories'] as string[]),
          skillTags: (raw['skillTags'] as string[]) ?? (raw['tags'] as string[]),
        };
        taskInferenceHints.set(t.task_key, hints);
      }
    } catch { /* table missing → graceful no-op */ }

    try {
      const scoreRows = await db.listCapabilityScores({ tenantId: opts?.tenantId ?? null });
      capabilityRows = scoreRows.map(r => ({
        modelId: r.model_id,
        providerId: r.provider,
        taskKey: r.task_key,
        qualityScore: r.quality_score,
        supportsTools: !!r.supports_tools,
        supportsStreaming: !!r.supports_streaming,
        supportsThinking: !!r.supports_thinking,
        supportsJsonMode: !!r.supports_json_mode,
        supportsVision: !!r.supports_vision,
        isActive: r.is_active === 1,
        tenantId: r.tenant_id,
      }));
      // Build modality map from model_pricing.output_modality if available
      for (const r of pricingRows) {
        const mod = (r as { output_modality?: string }).output_modality;
        if (mod) modalityMap.set(`${r.provider}:${r.model_id}`, mod as OutputModality);
      }
    } catch { /* table missing → graceful no-op */ }

    const decisionStore = new SqliteDecisionStore(db, {
      tenantId: opts?.tenantId ?? null,
      agentId: opts?.agentId ?? null,
      workflowStepId: opts?.workflowStepId ?? null,
      weights: active.weights ? safeParse(active.weights) : undefined,
    });

    const router = new SmartModelRouter({
      candidates: routerCandidates,
      costs,
      qualities,
      initialHealth: healthList,
      capabilityRows,
      taskInferenceHints,
      modalityMap,
      decisionStore,
    });

    const decision = await router.route(
      {
        prompt: opts?.prompt ?? '',
        context: {
          taskType: opts?.taskType,
          tools: opts?.tools,
          skill: opts?.skill,
          prompt: opts?.prompt,
          outputModality: opts?.outputModality,
          maxCostPerCall: opts?.maxCostPerCall,
          tenantId: opts?.tenantId ?? undefined,
          agentId: opts?.agentId ?? undefined,
        },
      },
      {
        id: active.id,
        name: active.name,
        strategy: active.strategy as any,
        constraints: active.constraints ? safeParse(active.constraints) : undefined,
        weights: active.weights ? safeParse(active.weights) : undefined,
        fallbackModelId: active.fallback_model ?? undefined,
        fallbackProviderId: active.fallback_provider ?? undefined,
        fallbackChain: (active as { fallback_chain?: string }).fallback_chain ? safeParse((active as { fallback_chain?: string }).fallback_chain!) : undefined,
        enabled: true,
      },
    );

    return {
      provider: decision.providerId,
      modelId: decision.modelId,
      taskKey: decision.taskMeta?.taskKey,
      inferenceSource: decision.taskMeta?.inferenceSource,
    };
  } catch {
    return null;
  }
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return undefined; }
}

// ── Cache policy resolution ──────────────────────────────────

/**
 * Resolve the best-matching cache policy from admin-configured policies.
 */
export async function resolveActiveCache(
  db: DatabaseAdapter,
  _mode: string,
): Promise<CachePolicy | null> {
  try {
    const rows = await db.listCachePolicies();
    const enabled = rows.filter(r => r.enabled);
    if (!enabled.length) return null;
    const policies: CachePolicy[] = enabled.map(r => ({
      id: r.id,
      name: r.name,
      scope: (r.scope as CachePolicy['scope']) ?? 'global',
      ttlMs: r.ttl_ms ?? 300_000,
      maxEntries: r.max_entries ?? 1000,
      bypassPatterns: r.bypass_patterns ? JSON.parse(r.bypass_patterns) : [],
      invalidateOnEvents: r.invalidate_on ? JSON.parse(r.invalidate_on) : [],
      enabled: true,
    }));
    return resolvePolicy(policies, {}) ?? null;
  } catch {
    return null;
  }
}
