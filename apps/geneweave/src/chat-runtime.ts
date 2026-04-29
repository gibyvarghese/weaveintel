import type { Model } from '@weaveintel/core';
import type { ChatSettingsRow } from './db.js';
import { normalizePersona } from './rbac.js';
import { getDefaultToolsByMode } from './chat-policies.js';

export interface ChatAttachment {
  name: string;
  mimeType: string;
  size: number;
  dataBase64?: string;
  transcript?: string;
}

interface ModelPricing {
  input: number;
  output: number;
}

export const FALLBACK_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514': { input: 15.00, output: 75.00 },
  'claude-haiku-4-20250414': { input: 1.00, output: 5.00 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4.1': { input: 2.00, output: 8.00 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40 },
  'o3': { input: 2.00, output: 8.00 },
  'o4-mini': { input: 1.10, output: 4.40 },
};

export function calculateCost(modelId: string, promptTokens: number, completionTokens: number, pricingOverride?: ModelPricing): number {
  const pricing = pricingOverride ?? FALLBACK_PRICING[modelId];
  if (!pricing) return 0;
  return (promptTokens / 1_000_000) * pricing.input + (completionTokens / 1_000_000) * pricing.output;
}

export interface ProviderConfig {
  /** API key for cloud providers. Optional for local providers (ollama, llamacpp). */
  apiKey?: string;
  /** Base URL override (used by ollama, llamacpp, and any provider that supports it). */
  baseUrl?: string;
  mockResponses?: string[];
  latencyMs?: number;
}

export interface ChatEngineConfig {
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
  defaultModel: string;
}

const modelCache = new Map<string, Model>();

export async function getOrCreateModel(
  provider: string,
  modelId: string,
  providerConfig: ProviderConfig,
): Promise<Model> {
  const bareModel = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
  const cacheKey = `${provider}:${bareModel}`;
  const cached = modelCache.get(cacheKey);
  if (cached) return cached;

  let model: Model;
  switch (provider) {
    case 'anthropic': {
      const mod = await import('@weaveintel/provider-anthropic');
      model = (mod as any).weaveAnthropicModel(bareModel, { apiKey: providerConfig.apiKey });
      break;
    }
    case 'openai': {
      const mod = await import('@weaveintel/provider-openai');
      model = (mod as any).weaveOpenAIModel(bareModel, { apiKey: providerConfig.apiKey });
      break;
    }
    case 'google':
    case 'gemini': {
      const mod = await import('@weaveintel/provider-google');
      model = (mod as any).weaveGoogleModel(bareModel, { apiKey: providerConfig.apiKey });
      break;
    }
    case 'ollama': {
      const mod = await import('@weaveintel/provider-ollama');
      model = (mod as any).weaveOllamaModel(bareModel, {
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
      });
      break;
    }
    case 'llamacpp':
    case 'llama-cpp': {
      const mod = await import('@weaveintel/provider-llamacpp');
      model = (mod as any).weaveLlamaCppModel(bareModel, {
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
      });
      break;
    }
    case 'mock': {
      const mod = await import('@weaveintel/devtools');
      model = (mod as any).createMockModel({
        name: bareModel || 'mock-model',
        responses: providerConfig.mockResponses,
        latencyMs: providerConfig.latencyMs ?? 25,
      });
      break;
    }
    default:
      throw new Error(`Unsupported provider "${provider}". Install @weaveintel/provider-${provider}`);
  }

  modelCache.set(cacheKey, model);
  return model;
}

export interface ChatSettings {
  mode: 'direct' | 'agent' | 'supervisor';
  systemPrompt?: string;
  timezone?: string;
  enabledTools: string[];
  redactionEnabled: boolean;
  redactionPatterns: string[];
  workers: WorkerDef[];
  /** Phase 6: tool policy key from the top-matched active skill; overrides global tool policy */
  skillPolicyKey?: string;
  /**
   * Tools that the currently active skill(s) contribute. When non-empty, the
   * supervisor's default extra-tool set is filtered to exclude these tools so
   * the supervisor cannot short-circuit around the skill's intended worker
   * delegation. Purely data-driven from the `skills.tool_names` column.
   */
  skillContributedTools?: string[];
}

export interface WorkerDef {
  name: string;
  description: string;
  tools: string[];
  persona?: string;
}

const DEFAULT_SETTINGS: ChatSettings = {
  mode: 'direct',
  enabledTools: getDefaultToolsByMode('direct'),
  redactionEnabled: false,
  redactionPatterns: ['email', 'phone', 'ssn', 'credit_card'],
  workers: [],
};

export function settingsFromRow(row: ChatSettingsRow | null): ChatSettings {
  if (!row) return { ...DEFAULT_SETTINGS };

  const mode = (row.mode as ChatSettings['mode']) || 'direct';
  const enabledTools = row.enabled_tools
    ? JSON.parse(row.enabled_tools)
    : getDefaultToolsByMode(mode);

  return {
    mode,
    systemPrompt: row.system_prompt ?? undefined,
    timezone: row.timezone ?? undefined,
    enabledTools,
    redactionEnabled: !!row.redaction_enabled,
    redactionPatterns: row.redaction_patterns ? JSON.parse(row.redaction_patterns) : DEFAULT_SETTINGS.redactionPatterns,
    workers: row.workers
      ? (JSON.parse(row.workers) as WorkerDef[]).map((worker) => ({
          ...worker,
          persona: normalizePersona(worker.persona, 'agent'),
        }))
      : [],
  };
}
