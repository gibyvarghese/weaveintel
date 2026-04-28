/**
 * @weaveintel/routing — Task type inference
 *
 * Pure helper that maps a request (explicit task type, agent default, tools,
 * skill metadata, prompt text) to a single task key. Implements the priority
 * chain in §6 of the anyWeave Task-Aware LLM Routing spec.
 */

import type {
  TaskTypeInferenceHints,
  TaskTypeInferenceSource,
  RoutingToolDescriptor as ToolDescriptor,
} from '@weaveintel/core';

export interface InferTaskTypeInput {
  /** Explicit task key passed by the caller (highest priority). */
  explicit?: string;
  /** Agent's `default_task_type` column. */
  agentDefaultTaskType?: string | null;
  /** Tools the agent will use. */
  tools?: ToolDescriptor[];
  /** Skill metadata. */
  skill?: { key?: string; category?: string; tags?: string[] } | null;
  /** Prompt text used for keyword-based inference. */
  prompt?: string;
}

/** Per-task inference hints, indexed by task key. */
export type TaskInferenceHintsMap = Map<string, TaskTypeInferenceHints>;

export interface InferTaskTypeResult {
  taskKey: string;
  source: TaskTypeInferenceSource;
}

const DEFAULT_TASK_KEY = 'text_generation';

/**
 * Infer a task key. Priority order:
 *   1. explicit            (caller knows best)
 *   2. agent_default       (agent.default_task_type)
 *   3. tool_inference      (tool name matches a task's toolPatterns)
 *   4. skill_metadata      (skill.category / skill.tags overlap with hints)
 *   5. prompt_inference    (prompt contains keyword)
 *   6. default             (text_generation)
 */
export function inferTaskType(
  input: InferTaskTypeInput,
  hints: TaskInferenceHintsMap,
): InferTaskTypeResult {
  if (input.explicit) return { taskKey: input.explicit, source: 'explicit' };

  if (input.agentDefaultTaskType) {
    return { taskKey: input.agentDefaultTaskType, source: 'agent_default' };
  }

  // Tool-based inference: any tool name matches any task's toolPatterns regex/glob-ish?
  if (input.tools && input.tools.length > 0) {
    const toolHit = matchTools(input.tools, hints);
    if (toolHit) return { taskKey: toolHit, source: 'tool_inference' };
  }

  // Skill metadata
  if (input.skill) {
    const skillHit = matchSkill(input.skill, hints);
    if (skillHit) return { taskKey: skillHit, source: 'skill_metadata' };
  }

  // Prompt keyword scan
  if (input.prompt && input.prompt.trim().length > 0) {
    const promptHit = matchPrompt(input.prompt, hints);
    if (promptHit) return { taskKey: promptHit, source: 'prompt_inference' };
  }

  return { taskKey: DEFAULT_TASK_KEY, source: 'default' };
}

function matchTools(tools: ToolDescriptor[], hints: TaskInferenceHintsMap): string | null {
  const names = tools.map(t => t.name.toLowerCase());
  for (const [taskKey, h] of hints.entries()) {
    if (!h.toolPatterns || h.toolPatterns.length === 0) continue;
    for (const pat of h.toolPatterns) {
      const p = pat.toLowerCase();
      if (names.some(n => n === p || n.includes(p))) return taskKey;
    }
  }
  return null;
}

function matchSkill(
  skill: { key?: string; category?: string; tags?: string[] },
  hints: TaskInferenceHintsMap,
): string | null {
  const cat = skill.category?.toLowerCase();
  const tags = (skill.tags ?? []).map(t => t.toLowerCase());
  for (const [taskKey, h] of hints.entries()) {
    const cats = (h.skillCategories ?? []).map(s => s.toLowerCase());
    const tagHints = (h.skillTags ?? []).map(s => s.toLowerCase());
    if (cat && cats.includes(cat)) return taskKey;
    if (tags.length && tagHints.some(t => tags.includes(t))) return taskKey;
  }
  return null;
}

function matchPrompt(prompt: string, hints: TaskInferenceHintsMap): string | null {
  const lower = prompt.toLowerCase();
  // Score by # of keyword hits to disambiguate; ties broken by insertion order.
  let bestKey: string | null = null;
  let bestHits = 0;
  for (const [taskKey, h] of hints.entries()) {
    const kws = (h.promptKeywords ?? []).map(k => k.toLowerCase()).filter(Boolean);
    if (kws.length === 0) continue;
    let hits = 0;
    for (const kw of kws) {
      if (lower.includes(kw)) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestKey = taskKey;
    }
  }
  return bestKey;
}
