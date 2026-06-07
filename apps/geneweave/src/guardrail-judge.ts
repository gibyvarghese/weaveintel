/**
 * GeneWeave — guardrail-judge.ts
 *
 * Model and agent resolution for guardrail evaluation.
 *
 * Two modes:
 *
 * 1. Direct model call (pre-execution / injection classifier)
 *    getGuardrailJudgeModel() → Model
 *    Used directly in the llm-judge evaluator. Zero overhead, synchronous.
 *    Right choice for blocking pre-execution checks where the user is waiting.
 *
 * 2. weaveAgent wrapper (post-execution checks)
 *    createGuardrailJudgeAgent() → Agent
 *    Wraps the same model in a single-step agent for audit trail + observability.
 *    Each post-execution check gets its own agent identity and span.
 *    maxSteps:1 means it's identical latency to a direct call but goes through
 *    the agent loop (weaveAudit, span attribution, structured output enforcement).
 *
 * Model selection priority:
 *   1. GUARDRAIL_JUDGE_PROVIDER / GUARDRAIL_JUDGE_MODEL env vars
 *   2. Cheapest fast model from the configured providers
 *      (claude-haiku-4-5 > gpt-4o-mini > gemini-flash > the default model)
 *   3. Falls back to the app's defaultProvider / defaultModel
 *
 * Why not a supervisor?
 *   A guardrail supervisor dispatching sub-agents would add 200-500 ms of
 *   orchestration overhead per chat turn. For synchronous blocking checks that
 *   is too much. The parallel pipeline already achieves the same throughput.
 *   A supervisor IS the right pattern for async/offline audit replay — that
 *   can be layered on top of the existing guardrail_evals table later.
 */
import type { Agent, EmbeddingModel, Model, ModerationModel } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { getOrCreateModel, type ProviderConfig } from './chat-runtime.js';

// ── Model priority list ────────────────────────────────────────────────────

/** Preferred judge models per provider — cheapest fast model first. */
const JUDGE_MODEL_PREFERENCE: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.0-flash',
  gemini: 'gemini-2.0-flash',
};

export interface GuardrailJudgeConfig {
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
  defaultModel: string;
}

/**
 * Resolve the judge model from env vars or the cheapest configured provider.
 * Returns `undefined` if no provider is configured (model-graded checks skip).
 */
export async function getGuardrailJudgeModel(
  config: GuardrailJudgeConfig,
): Promise<Model | undefined> {
  // Explicit env override takes priority.
  const envProvider = process.env['GUARDRAIL_JUDGE_PROVIDER'];
  const envModel = process.env['GUARDRAIL_JUDGE_MODEL'];

  if (envProvider && envModel) {
    const providerCfg = config.providers[envProvider];
    if (providerCfg) {
      try {
        return await getOrCreateModel(envProvider, envModel, providerCfg);
      } catch {
        // fall through to preference order
      }
    }
  }

  // Walk preference list — use the first configured provider.
  for (const [provider, preferredModel] of Object.entries(JUDGE_MODEL_PREFERENCE)) {
    const providerCfg = config.providers[provider];
    if (!providerCfg?.apiKey?.trim()) continue;
    const modelId = envModel ?? preferredModel;
    try {
      return await getOrCreateModel(provider, modelId, providerCfg);
    } catch {
      continue;
    }
  }

  // Last resort: use the app default model/provider.
  const defaultCfg = config.providers[config.defaultProvider];
  if (defaultCfg) {
    try {
      return await getOrCreateModel(config.defaultProvider, config.defaultModel, defaultCfg);
    } catch {
      // no model available
    }
  }

  return undefined;
}

// ── Single-step weaveAgent wrapper ─────────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `You are a guardrail evaluation agent. You receive a piece of text and must evaluate it according to the rubric provided.

Always respond with a single JSON object containing exactly these fields:
- "decision": one of "allow", "warn", or "deny"
- "confidence": a number between 0 and 1
- "rationale": one concise sentence explaining your reasoning

Respond ONLY with the JSON object. No markdown, no explanation outside the JSON.`;

let _judgeAgent: Agent | undefined;

/**
 * Returns a cached single-step weaveAgent used for post-execution guardrail checks.
 * maxSteps:1 means it runs as a single model call but with full agent observability.
 */
export function createGuardrailJudgeAgent(model: Model): Agent {
  if (_judgeAgent) return _judgeAgent;
  _judgeAgent = weaveAgent({
    name: 'guardrail-judge',
    model,
    systemPrompt: AGENT_SYSTEM_PROMPT,
    maxSteps: 1,
  });
  return _judgeAgent;
}

/** Reset cached agent (call when model changes at runtime). */
export function resetGuardrailJudgeAgent(): void {
  _judgeAgent = undefined;
}

// ── Module-level active judge model ────────────────────────────────────────
// Set once at boot by createGeneWeave(); consumed by chat-guardrail-eval-utils
// and the guardrails-slot without threading through every deps chain.

let _activeJudgeModel: Model | undefined;

export function setActiveGuardrailJudgeModel(model: Model | undefined): void {
  _activeJudgeModel = model;
  resetGuardrailJudgeAgent(); // rebuild agent with new model
}

export function getActiveGuardrailJudgeModel(): Model | undefined {
  return _activeJudgeModel;
}

// ── Moderation model (R2) ──────────────────────────────────────────────────
// Uses OpenAI omni-moderation-latest; requires OPENAI_API_KEY.

let _activeModerationModel: ModerationModel | undefined;

export async function getGuardrailModerationModel(
  providers: Record<string, ProviderConfig>,
): Promise<ModerationModel | undefined> {
  const apiKey = process.env['GUARDRAIL_MODERATION_API_KEY']
    ?? providers['openai']?.apiKey;
  if (!apiKey?.startsWith('sk-')) return undefined;
  try {
    const mod = await import('@weaveintel/provider-openai');
    const fn = (mod as unknown as Record<string, unknown>)['weaveOpenAIModerationModel']
      ?? (mod as unknown as Record<string, unknown>)['weaveOpenAIModeration'];
    if (typeof fn !== 'function') return undefined;
    // First arg is modelId (string), second is provider options — pass them separately.
    return fn('omni-moderation-latest', { apiKey }) as ModerationModel;
  } catch {
    return undefined;
  }
}

export function setActiveGuardrailModerationModel(m: ModerationModel | undefined): void {
  _activeModerationModel = m;
}

export function getActiveGuardrailModerationModel(): ModerationModel | undefined {
  return _activeModerationModel;
}

// ── Embedding model (R3) ───────────────────────────────────────────────────
// Uses text-embedding-3-small for semantic grounding; requires OPENAI_API_KEY.

let _activeEmbeddingModel: EmbeddingModel | undefined;

export async function getGuardrailEmbeddingModel(
  providers: Record<string, ProviderConfig>,
): Promise<EmbeddingModel | undefined> {
  const envProvider = process.env['GUARDRAIL_EMBEDDING_PROVIDER'];
  const envModel = process.env['GUARDRAIL_EMBEDDING_MODEL'] ?? 'text-embedding-3-small';
  const apiKey = process.env['GUARDRAIL_EMBEDDING_API_KEY']
    ?? providers[envProvider ?? 'openai']?.apiKey
    ?? providers['openai']?.apiKey;
  if (!apiKey?.startsWith('sk-')) return undefined;
  try {
    const mod = await import('@weaveintel/provider-openai');
    const fn = (mod as unknown as Record<string, unknown>)['weaveOpenAIEmbeddingModel']
      ?? (mod as unknown as Record<string, unknown>)['weaveOpenAIEmbedding'];
    if (typeof fn !== 'function') return undefined;
    return fn(envModel, { apiKey }) as EmbeddingModel;
  } catch {
    return undefined;
  }
}

export function setActiveGuardrailEmbeddingModel(m: EmbeddingModel | undefined): void {
  _activeEmbeddingModel = m;
}

export function getActiveGuardrailEmbeddingModel(): EmbeddingModel | undefined {
  return _activeEmbeddingModel;
}
