/**
 * Framework seed — writes default package seed arrays to the database.
 *
 * Each section is idempotent: it checks existence before inserting.
 * Call this from applySeed() only; do not call directly from app startup.
 */

import { newUUIDv7 } from '@weaveintel/core';
import { getModelCapabilityFlags } from '@weaveintel/routing';
import { DEFAULT_GUARDRAILS } from '@weaveintel/guardrails';
import {
  DEFAULT_ROUTING_POLICIES,
  DEFAULT_MODEL_PRICING,
  DEFAULT_TASK_TYPES,
  DEFAULT_PROVIDER_ADAPTERS,
} from '@weaveintel/routing';
import { DEFAULT_HANDLER_KINDS, DEFAULT_ATTENTION_POLICIES } from '@weaveintel/live-agents';
import { DEFAULT_COST_POLICIES } from '@weaveintel/cost-governor';
import { BUILT_IN_SKILLS, mapSkillToRow } from '@weaveintel/skills';
import type { DatabaseAdapter } from '../db-types.js';

export async function seedFramework(db: DatabaseAdapter): Promise<void> {
  // ── Guardrails ───────────────────────────────────────────────────────────────
  const existingGuardrails = await db.listGuardrails();
  if (existingGuardrails.length === 0) {
    for (const g of DEFAULT_GUARDRAILS) await db.createGuardrail(g);
  } else {
    // Backfill: insert any new guardrail IDs that are missing (e.g. after a
    // framework update adds new built-ins to DEFAULT_GUARDRAILS).
    const existingIds = new Set(existingGuardrails.map(g => g.id));
    for (const g of DEFAULT_GUARDRAILS) {
      if (!existingIds.has(g.id)) await db.createGuardrail(g);
    }
  }

  // ── Routing Policies ─────────────────────────────────────────────────────────
  const existingPolicies = await db.listRoutingPolicies();
  if (existingPolicies.length === 0) {
    for (const p of DEFAULT_ROUTING_POLICIES) await db.createRoutingPolicy(p);
  }

  // ── Model Pricing ─────────────────────────────────────────────────────────────
  const existingPricing = await db.listModelPricing();
  if (existingPricing.length === 0) {
    for (const p of DEFAULT_MODEL_PRICING) await db.createModelPricing(p);
  }

  // ── Task Type Definitions ─────────────────────────────────────────────────────
  const existingTaskTypes = await db.listTaskTypes();
  if (existingTaskTypes.length === 0) {
    for (const t of DEFAULT_TASK_TYPES) {
      await db.createTaskType({
        id:               newUUIDv7(),
        task_key:         t.task_key,
        display_name:     t.display_name,
        category:         t.category,
        description:      t.description,
        output_modality:  t.output_modality,
        default_strategy: t.default_strategy,
        default_weights:  JSON.stringify(t.default_weights),
        inference_hints:  JSON.stringify(t.inference_hints),
        enabled:          1,
      });
    }
  }

  // ── Provider Tool Adapters ────────────────────────────────────────────────────
  const existingAdapters = await db.listProviderToolAdapters();
  if (existingAdapters.length === 0) {
    for (const a of DEFAULT_PROVIDER_ADAPTERS) {
      await db.createProviderToolAdapter({ id: newUUIDv7(), ...a });
    }
  } else {
    // Backfill ollama adapter if missing (added in Phase 3)
    const hasOllama = existingAdapters.some(a => a.provider === 'ollama');
    if (!hasOllama) {
      const ollama = DEFAULT_PROVIDER_ADAPTERS.find(a => a.provider === 'ollama')!;
      await db.createProviderToolAdapter({ id: newUUIDv7(), ...ollama });
    }
  }

  // ── Cost Policies (framework tiers) ──────────────────────────────────────────
  const existingCostPolicies = await db.listCostPolicies();
  const existingCostKeys = new Set(existingCostPolicies.map(p => p.key));
  for (const p of DEFAULT_COST_POLICIES) {
    if (!existingCostKeys.has(p.key)) {
      await db.createCostPolicy({
        id:          p.id,
        key:         p.key,
        tier:        p.tier,
        levers_json: p.levers_json,
        description: p.description,
        enabled:     p.enabled,
      });
    }
  }

  // ── Live Agent Handler Kinds ──────────────────────────────────────────────────
  for (const k of DEFAULT_HANDLER_KINDS) {
    const existing = await db.getLiveHandlerKindByKind(k.kind);
    if (!existing) await db.createLiveHandlerKind(k);
  }

  // ── Live Agent Attention Policies ─────────────────────────────────────────────
  for (const p of DEFAULT_ATTENTION_POLICIES) {
    const existing = await db.getLiveAttentionPolicyByKey(p.key);
    if (!existing) await db.createLiveAttentionPolicy(p);
  }

  // ── Skills (BUILT_IN_SKILLS from @weaveintel/skills) ──────────────────────────
  const existingSkills = await db.listSkills();
  if (existingSkills.length === 0) {
    for (const s of BUILT_IN_SKILLS) await db.createSkill(mapSkillToRow(s));
  } else {
    // Backfill: insert any new built-in skills added in package updates
    const existingSkillIds = new Set(existingSkills.map(s => s.id));
    for (const s of BUILT_IN_SKILLS) {
      if (!existingSkillIds.has(s.id)) await db.createSkill(mapSkillToRow(s));
    }
  }

  // ── Model Capability Scores ────────────────────────────────────────────────────
  // Only seed if no scores exist. The anyWeave router requires at least the
  // 10 currently-priced models × their applicable tasks.
  const existingScores = await db.listCapabilityScores();
  if (existingScores.length === 0) {
    await seedModelCapabilityScores(db);
  }
}

async function seedModelCapabilityScores(db: DatabaseAdapter): Promise<void> {
  const flags = getModelCapabilityFlags;

  type CapSeed = { model_id: string; provider: string; task_key: string; quality_score: number };

  const scores: CapSeed[] = [
    // Anthropic
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
      model_id: 'claude-opus-4-7', provider: 'anthropic', task_key: task,
      quality_score: ({ reasoning: 95, summarization: 90, translation: 88, classification: 90, extraction: 92, qa: 93, code_generation: 94, code_debug: 95, code_review: 95, creative_writing: 96, conversation: 92, tool_use: 93, vision_understanding: 90 }[task] ?? 90),
    })),
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
      model_id: 'claude-sonnet-4-6', provider: 'anthropic', task_key: task,
      quality_score: ({ reasoning: 88, summarization: 88, translation: 86, classification: 88, extraction: 89, qa: 88, code_generation: 90, code_debug: 89, code_review: 88, creative_writing: 90, conversation: 90, tool_use: 89, vision_understanding: 86 }[task] ?? 85),
    })),
    ...['summarization', 'classification', 'extraction', 'qa', 'translation', 'conversation', 'tool_use'].map(task => ({
      model_id: 'claude-haiku-4-5-20251001', provider: 'anthropic', task_key: task,
      quality_score: ({ summarization: 78, classification: 78, extraction: 76, qa: 75, translation: 74, conversation: 80, tool_use: 75 }[task] ?? 70),
    })),
    // OpenAI
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
      model_id: 'gpt-4o', provider: 'openai', task_key: task,
      quality_score: ({ reasoning: 88, summarization: 90, translation: 92, classification: 89, extraction: 90, qa: 91, code_generation: 89, code_debug: 88, code_review: 87, creative_writing: 88, conversation: 91, tool_use: 92, vision_understanding: 92 }[task] ?? 88),
    })),
    ...['summarization', 'classification', 'extraction', 'qa', 'translation', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
      model_id: 'gpt-4o-mini', provider: 'openai', task_key: task,
      quality_score: ({ summarization: 80, classification: 82, extraction: 80, qa: 78, translation: 82, conversation: 82, tool_use: 80, vision_understanding: 78 }[task] ?? 75),
    })),
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
      model_id: 'gpt-4.1', provider: 'openai', task_key: task,
      quality_score: ({ reasoning: 89, summarization: 89, translation: 90, classification: 89, extraction: 90, qa: 90, code_generation: 91, code_debug: 90, code_review: 88, creative_writing: 87, conversation: 89, tool_use: 91, vision_understanding: 89 }[task] ?? 88),
    })),
    ...['summarization', 'classification', 'extraction', 'qa', 'translation', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
      model_id: 'gpt-4.1-mini', provider: 'openai', task_key: task,
      quality_score: ({ summarization: 80, classification: 82, extraction: 80, qa: 78, translation: 82, conversation: 81, tool_use: 80, vision_understanding: 76 }[task] ?? 75),
    })),
    ...['summarization', 'classification', 'extraction', 'conversation'].map(task => ({
      model_id: 'gpt-4.1-nano', provider: 'openai', task_key: task,
      quality_score: ({ summarization: 70, classification: 72, extraction: 68, conversation: 72 }[task] ?? 65),
    })),
    ...['reasoning', 'qa', 'code_generation', 'code_debug', 'code_review', 'tool_use'].map(task => ({
      model_id: 'o3', provider: 'openai', task_key: task,
      quality_score: ({ reasoning: 96, qa: 90, code_generation: 92, code_debug: 94, code_review: 91, tool_use: 88 }[task] ?? 88),
    })),
    ...['reasoning', 'qa', 'code_generation', 'code_debug', 'code_review', 'tool_use'].map(task => ({
      model_id: 'o4-mini', provider: 'openai', task_key: task,
      quality_score: ({ reasoning: 88, qa: 82, code_generation: 86, code_debug: 87, code_review: 84, tool_use: 82 }[task] ?? 80),
    })),
    // Google
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'code_debug', 'code_review', 'creative_writing', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
      model_id: 'gemini-2.5-pro', provider: 'google', task_key: task,
      quality_score: ({ reasoning: 90, summarization: 87, translation: 90, classification: 88, extraction: 89, qa: 90, code_generation: 88, code_debug: 87, code_review: 87, creative_writing: 87, conversation: 88, tool_use: 90, vision_understanding: 92 }[task] ?? 88),
    })),
    ...['reasoning', 'summarization', 'translation', 'classification', 'extraction', 'qa', 'code_generation', 'conversation', 'tool_use', 'vision_understanding'].map(task => ({
      model_id: 'gemini-2.5-flash', provider: 'google', task_key: task,
      quality_score: ({ reasoning: 80, summarization: 82, translation: 84, classification: 82, extraction: 81, qa: 82, code_generation: 78, conversation: 80, tool_use: 80, vision_understanding: 82 }[task] ?? 78),
    })),
    ...['summarization', 'classification', 'extraction', 'qa', 'conversation'].map(task => ({
      model_id: 'gemini-2.5-flash-lite', provider: 'google', task_key: task,
      quality_score: ({ summarization: 74, classification: 75, extraction: 72, qa: 72, conversation: 70 }[task] ?? 68),
    })),
    // Ollama (local heuristic baselines)
    ...['summarization', 'classification', 'extraction', 'qa', 'conversation', 'tool_use'].map(task => ({
      model_id: 'llama3.1', provider: 'ollama', task_key: task,
      quality_score: ({ summarization: 72, classification: 72, extraction: 70, qa: 70, conversation: 70, tool_use: 68 }[task] ?? 68),
    })),
    ...['summarization', 'classification', 'extraction', 'qa', 'conversation'].map(task => ({
      model_id: 'deepseek-r1', provider: 'ollama', task_key: task,
      quality_score: ({ summarization: 78, classification: 80, extraction: 78, qa: 80, conversation: 75 }[task] ?? 72),
    })),
  ];

  for (const s of scores) {
    const f = flags(s.model_id);
    await db.upsertCapabilityScore({
      id:                      newUUIDv7(),
      tenant_id:               null,
      model_id:                s.model_id,
      provider:                s.provider,
      task_key:                s.task_key,
      quality_score:           s.quality_score,
      supports_tools:          1,
      supports_streaming:      1,
      supports_thinking:       f.supports_thinking,
      supports_json_mode:      f.supports_json_mode,
      supports_vision:         f.supports_vision,
      max_output_tokens:       null,
      benchmark_source:        'composite-2025q2',
      raw_benchmark_score:     null,
      is_active:               1,
      last_evaluated_at:       new Date().toISOString(),
      production_signal_score: null,
      signal_sample_count:     0,
    });
  }
}
