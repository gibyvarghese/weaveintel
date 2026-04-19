/**
 * @weaveintel/geneweave — Chat engine
 *
 * Orchestrates weaveIntel models for chat. Supports three modes:
 *  - **direct**: model.generate / model.stream (default, original behavior)
 *  - **agent**: weaveAgent with tool-calling ReAct loop
 *  - **supervisor**: weaveSupervisor with hierarchical worker delegation
 *
 * Integrates redaction (PII scrubbing), observability (trace spans),
 * and eval (response quality assertions) into the message flow.
 *
 * WeaveIntel packages integrated here:
 *   @weaveintel/core         — ExecutionContext, EventBus, Model/ToolRegistry types
 *   @weaveintel/agents       — weaveAgent (ReAct loop) and weaveSupervisor
 *   @weaveintel/observability — weaveInMemoryTracer, weaveUsageTracker for spans
 *   @weaveintel/redaction     — weaveRedactor for PII scrubbing before/after LLM
 *   @weaveintel/evals         — weaveEvalRunner for response quality assertions
 *   @weaveintel/guardrails    — createGuardrailPipeline, risk classification
 *   @weaveintel/human-tasks   — PolicyEvaluator for automatic human-review triggers
 *   @weaveintel/prompts       — shared prompt record parsing + variable-substituted rendering
 *   @weaveintel/routing       — SmartModelRouter, ModelHealthTracker
 *   @weaveintel/cache         — weaveInMemoryCacheStore, semantic cache for responses
 */

import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type {
  Model, ModelRequest, ModelResponse, StreamChunk, ExecutionContext, Message,
  ToolRegistry, AgentStepEvent, AgentStep, AgentResult, EventBus,
  Guardrail, GuardrailResult, GuardrailStage,
  CapabilityTelemetrySummary,
} from '@weaveintel/core';
import { weaveContext, weaveEventBus, EventTypes } from '@weaveintel/core';
import { weaveAgent, weaveSupervisor } from '@weaveintel/agents';
import {
  weaveInMemoryTracer,
  weaveUsageTracker,
  capabilityTelemetryToEvent,
  capabilityTelemetryToSpanAttributes,
} from '@weaveintel/observability';
import { weaveRedactor } from '@weaveintel/redaction';
import { weaveEvalRunner } from '@weaveintel/evals';
import { createGuardrailPipeline, hasDeny, hasWarning, getDenyReason, summarizeGuardrailResults, type GuardrailCategorySummary } from '@weaveintel/guardrails';
import type { DatabaseAdapter, MessageRow, ChatSettingsRow, GuardrailRow, HumanTaskPolicyRow, PromptRow, RoutingPolicyRow } from './db.js';
import { createToolRegistry, type ToolRegistryOptions } from './tools.js';
import { createTemporalStore } from './temporal-store.js';
import { PolicyEvaluator, createPolicy } from '@weaveintel/human-tasks';
import {
  createPromptVersionFromRecord,
  createTemplate,
  executePromptRecord,
  resolveFragments,
  InMemoryFragmentRegistry,
  InMemoryPromptStrategyRegistry,
  fragmentFromRecord,
  strategyFromRecord,
  defaultPromptStrategyRegistry,
  resolvePromptRecordForExecution,
  contractFromRecord,
  validateContract,
  InMemoryContractRegistry,
  type ContractValidationResult,
  type PromptRecordExecutionResult,
  createPromptCapabilityTelemetry,
} from '@weaveintel/prompts';
import {
  activateSkills,
  applySkillsToPrompt,
  collectSkillTools,
  createSkillRegistry,
  skillFromRow,
  type SkillDefinition,
  type SkillMatch,
} from '@weaveintel/skills';
import { createContract, DefaultCompletionValidator } from '@weaveintel/contracts';
import { SmartModelRouter, ModelHealthTracker } from '@weaveintel/routing';
import type { ModelCostInfo, ModelQualityInfo } from '@weaveintel/routing';
import { weaveInMemoryCacheStore } from '@weaveintel/cache';
import { weaveCacheKeyBuilder } from '@weaveintel/cache';
import { shouldBypass, resolvePolicy } from '@weaveintel/cache';
import type { CachePolicy } from '@weaveintel/core';
import { runHybridMemoryExtraction, type ExtractedEntity, type MemoryExtractionRule } from '@weaveintel/memory';
import { createEnterpriseTools, createEnterpriseToolGroups, ServiceNowProvider, type EnterpriseConnectorConfig, type EnterpriseToolGroup } from '@weaveintel/tools-enterprise';
import { normalizePersona } from './rbac.js';
import {
  TEMPORAL_TOOL_POLICY,
  POLICY_PROMPT_RESPONSE_CARD_FORMAT,
  POLICY_PROMPT_ENTERPRISE_WORKER_SYSTEM,
  POLICY_PROMPT_FORCED_WORKER_REQUIREMENT,
  POLICY_PROMPT_HARD_EXECUTION_GUARD,
  FORCED_WORKER_REQUIREMENT,
  HARD_EXECUTION_GUARD_POLICY,
  ENTERPRISE_WORKER_SYSTEM_PROMPT,
  RESPONSE_CARD_FORMAT_POLICY,
} from './chat-policies.js';
import {
  FALLBACK_PRICING,
  calculateCost,
  getOrCreateModel,
  settingsFromRow,
  type ChatAttachment,
  type ChatEngineConfig,
  type ChatSettings,
  type ProviderConfig,
  type WorkerDef,
} from './chat-runtime.js';
import { normalizeGuardrail, stageMatches } from './chat-guardrail-utils.js';
import {
  buildAttachmentContext,
  composeUserInput,
  normalizeAttachments,
  patchLatestUserMessage,
} from './chat-attachment-utils.js';
import {
  hasCodeExecutorDelegation,
  hasSuccessfulCseExecution,
} from './chat-cse-utils.js';
import { hasRenderableAttachmentAnalysisOutput } from './chat-output-guards.js';
import {
  extractFieldValue,
  outputContainsField,
  runWithContractGuard as runWithContractGuardHelper,
} from './chat-contract-guard-utils.js';
import { buildSupervisorInstructionsPrompt } from './chat-supervisor-policy-utils.js';
import { applyTemporalToolPolicy } from './chat-policy-format-utils.js';
import { shouldForceWorkerDataAnalysis } from './chat-intent-utils.js';

export { calculateCost, getOrCreateModel, settingsFromRow } from './chat-runtime.js';
export type { ChatAttachment, ProviderConfig, ChatEngineConfig, ChatSettings, WorkerDef } from './chat-runtime.js';

// ─── Model pricing (per 1 M tokens) ─────────────────────────

interface ModelPricing { input: number; output: number }

interface PromptContractCheckResult {
  key: string;
  name: string;
  contractType: string;
  valid: boolean;
  severity: ContractValidationResult['severity'];
  message: string;
  errorCount: number;
  repairSuggestion?: string;
}

interface PromptContractValidationSummary {
  total: number;
  passed: number;
  failed: number;
  error: number;
  warning: number;
  info: number;
}

interface PromptContractValidationReport {
  summary: PromptContractValidationSummary;
  results: PromptContractCheckResult[];
}

interface PromptStrategyInfo {
  requestedKey: string;
  resolvedKey: string;
  usedFallback: boolean;
  name: string;
  description: string;
  metadata?: Record<string, unknown>;
}

interface ResolvedSystemPrompt {
  content?: string;
  strategy?: PromptStrategyInfo;
  telemetry?: CapabilityTelemetrySummary;
  resolution?: {
    source: 'base_prompt' | 'prompt_version';
    resolvedVersion: string;
    selectedBy: 'requested_version' | 'experiment' | 'active_flag' | 'latest_published' | 'base_prompt';
    experimentId?: string;
    experimentVariantLabel?: string;
  };
}

// ─── Chat engine ─────────────────────────────────────────────

interface ToolCallObservableEvent {
  phase: 'start' | 'end' | 'error';
  timestamp: number;
  executionId?: string;
  spanId?: string;
  data: Record<string, unknown>;
}

interface AgentRunTelemetry {
  result: AgentResult;
  toolCallEvents: ToolCallObservableEvent[];
}

type CognitiveCheckSummary = GuardrailCategorySummary;

export class ChatEngine {
  private readonly healthTracker = new ModelHealthTracker();
  private readonly responseCache = weaveInMemoryCacheStore();
  private readonly cacheKeyBuilder = weaveCacheKeyBuilder({ namespace: 'gw-chat' });
  private pricingCache: Map<string, ModelPricing> | null = null;
  private pricingCacheTs = 0;
  private policyPromptCache: { ts: number; prompts: Map<string, string> } | null = null;
  private readonly toolOptions: ToolRegistryOptions;

  private async getPolicyPromptTemplates(): Promise<Map<string, string>> {
    const now = Date.now();
    if (this.policyPromptCache && now - this.policyPromptCache.ts < 30_000) {
      return this.policyPromptCache.prompts;
    }
    try {
      const prompts = await this.db.listPrompts();
      const enabled = new Map<string, string>();
      for (const prompt of prompts) {
        if (prompt.enabled) enabled.set(prompt.name, prompt.template);
      }
      this.policyPromptCache = { ts: now, prompts: enabled };
      return enabled;
    } catch {
      return new Map<string, string>();
    }
  }

  private async getPolicyPromptTemplate(name: string, fallback: string): Promise<string> {
    const prompts = await this.getPolicyPromptTemplates();
    return prompts.get(name) ?? fallback;
  }

  private async renderPolicyPromptTemplate(
    name: string,
    fallbackTemplate: string,
    vars: Record<string, unknown>,
  ): Promise<string> {
    const template = await this.getPolicyPromptTemplate(name, fallbackTemplate);
    try {
      const tpl = createTemplate({ id: name, name, template });
      return tpl.render(vars);
    } catch {
      return fallbackTemplate;
    }
  }

  private async withResponseCardFormatPolicy(basePrompt: string | undefined): Promise<string | undefined> {
    const policy = await this.getPolicyPromptTemplate(POLICY_PROMPT_RESPONSE_CARD_FORMAT, RESPONSE_CARD_FORMAT_POLICY);
    const base = basePrompt?.trim();
    return base ? `${base}\n\n${policy}` : policy;
  }

  constructor(
    private readonly config: ChatEngineConfig,
    private readonly db: DatabaseAdapter,
  ) {
    this.toolOptions = { temporalStore: createTemporalStore(db) };
  }

  private async discoverSkillsForInput(
    userContent: string,
    model: Model,
    ctx: ExecutionContext,
    mode: 'direct' | 'agent' | 'supervisor',
  ): Promise<{ matches: SkillMatch[]; toolNames: string[] }> {
    try {
      const rows = await this.db.listEnabledSkills();
      if (!rows.length) return { matches: [], toolNames: [] };

      const registry = createSkillRegistry();
      for (const row of rows) {
        registry.register(skillFromRow(row));
      }

      const allSkills = registry.list();
      const activation = await activateSkills(userContent, allSkills, {
        maxCandidates: 6,
        maxSelected: 3,
        minScore: 0.12,
        mode: mode === 'direct' ? 'advisory' : 'tool_assisted',
        context: { chatMode: mode },
        selector: async ({ query, mode: invokeMode, candidates }) => {
          const decision = await this.reasonAboutSkillSelection(model, ctx, query, invokeMode, candidates);
          if (!decision) {
            return {
              selectedSkillIds: candidates.slice(0, 3).map((candidate) => candidate.skill.id),
              rationale: 'Fallback to semantic ranking because reasoning selector did not return a valid decision.',
            };
          }
          return decision;
        },
        policyEvaluator: ({ skill, mode: invokeMode }) => {
          const disallowed = skill.policy?.sideEffectsAllowed === false && invokeMode === 'side_effect_eligible';
          if (disallowed) {
            return { allowed: false, reason: 'Skill blocks side-effect eligible execution in current mode.' };
          }

          return {
            allowed: true,
            enforcedAllowedTools: skill.policy?.allowedTools,
          };
        },
      });

      const matches = [...activation.selected];
      const toolNames = collectSkillTools(matches);
      return { matches, toolNames };
    } catch {
      return { matches: [], toolNames: [] };
    }
  }

  private async reasonAboutSkillSelection(
    model: Model,
    ctx: ExecutionContext,
    query: string,
    mode: string,
    candidates: readonly SkillMatch[],
  ): Promise<{ selectedSkillIds: string[]; rationale?: string; useNoSkillPath?: boolean } | null> {
    if (candidates.length <= 1) {
      return {
        selectedSkillIds: candidates.map((candidate) => candidate.skill.id),
        rationale: 'Only one semantic candidate available.',
      };
    }

    const compactCandidates = candidates.map((candidate, index) => ({
      rank: index + 1,
      id: candidate.skill.id,
      name: candidate.skill.name,
      score: Number(candidate.score.toFixed(3)),
      summary: candidate.skill.summary,
      whenToUse: candidate.skill.whenToUse,
      whenNotToUse: candidate.skill.whenNotToUse,
      policy: candidate.skill.policy,
    }));

    const selectionPrompt = [
      'Select the best skills for this request from the candidate list.',
      'Prioritize semantic fit, completion quality, and policy-safe execution.',
      'You may choose 0..3 skills. Choose zero if none fit.',
      'Respond ONLY as JSON with shape: {"selectedSkillIds": string[], "useNoSkillPath": boolean, "rationale": string }.',
      '',
      `Invocation mode: ${mode}`,
      `User request: ${query}`,
      `Candidates: ${JSON.stringify(compactCandidates)}`,
    ].join('\n');

    try {
      const response = await model.generate(ctx, {
        messages: [
          {
            role: 'system',
            content: 'You are a skill selector. Return strict JSON and prefer no skill over weak skill fit.',
          },
          {
            role: 'user',
            content: selectionPrompt,
          },
        ],
        temperature: 0,
        maxTokens: 350,
      });

      const parsed = this.safeParseJson(response.content);
      if (!parsed || typeof parsed !== 'object') return null;

      const rec = parsed as Record<string, unknown>;
      const selectedRaw = Array.isArray(rec['selectedSkillIds']) ? rec['selectedSkillIds'] : [];
      const selectedSkillIds = selectedRaw
        .filter((item): item is string => typeof item === 'string')
        .filter((id) => candidates.some((candidate) => candidate.skill.id === id))
        .slice(0, 3);

      const useNoSkillPath = rec['useNoSkillPath'] === true;
      const rationale = typeof rec['rationale'] === 'string' ? rec['rationale'] : undefined;

      return {
        selectedSkillIds,
        useNoSkillPath,
        rationale,
      };
    } catch {
      return null;
    }
  }

  /**
   * Build supervisor worker definitions from DB `worker_agents` rows.
   */
  private buildWorkersFromDb(
    workerRows: import('./db-types.js').WorkerAgentRow[],
    model: Model,
    toolOptions: ToolRegistryOptions,
    customTools?: Awaited<ReturnType<ChatEngine['loadEnterpriseTools']>>,
  ): Array<{ name: string; description: string; systemPrompt?: string; model: Model; tools?: ToolRegistry }> {
    const sorted = [...workerRows].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return sorted.map((row) => {
      const toolNames = (this.safeParseJson(row.tool_names) as string[]) ?? [];
      const systemPrompt = applyTemporalToolPolicy({
        basePrompt: row.system_prompt ?? undefined,
        toolNames,
        temporalToolPolicy: TEMPORAL_TOOL_POLICY,
      });
      const persona = normalizePersona(row.persona ?? undefined, 'agent');
      const tools = toolNames.length
        ? createToolRegistry(toolNames, customTools, { ...toolOptions, actorPersona: persona })
        : customTools?.length
          ? createToolRegistry([], customTools, { ...toolOptions, actorPersona: persona })
          : undefined;

      return {
        name: row.name,
        description: row.description,
        systemPrompt,
        model,
        tools,
      };
    });
  }

  /**
   * Generic contract-based execution guard. Delegates to a specific worker and validates
   * the output against the worker's task contract. Retries up to max_retries times.
   */
  private async runWithContractGuard(
    agent: { run: (ctx: ExecutionContext, input: { messages: Message[]; goal: string }) => Promise<AgentResult> },
    ctx: ExecutionContext,
    messages: Message[],
    goal: string,
    workerRow: import('./db-types.js').WorkerAgentRow,
  ): Promise<AgentResult> {
    return runWithContractGuardHelper({
      agent,
      ctx,
      messages,
      goal,
      workerRow,
      getTaskContract: async (id: string) => this.db.getTaskContract(id),
      parseJson: (text: string) => this.safeParseJson(text),
      validateAgainstContract: async (result: AgentResult, contractRow: import('./db-types.js').TaskContractRow) =>
        this.validateAgainstContract(result, contractRow),
    });
  }

  /**
   * Validate an agent result against a task contract's acceptance criteria.
   */
  private async validateAgainstContract(
    result: AgentResult,
    contractRow: import('./db-types.js').TaskContractRow,
  ): Promise<boolean> {
    const output = String(result.output ?? '');
    const criteria: Array<{ id: string; description: string; type: string; config: Record<string, unknown>; required: boolean }> =
      (this.safeParseJson(contractRow.acceptance_criteria) as Array<{ id: string; description: string; type: string; config: Record<string, unknown>; required: boolean }>) ?? [];

    // Build signal object from output using each criterion's field config
    const signal: Record<string, unknown> = {};
    for (const c of criteria) {
      const field = String(c.config?.['field'] ?? '');
      const operator = String(c.config?.['operator'] ?? '');
      if (operator === 'exists') {
        // Check if the field name appears meaningfully in the output
        signal[field] = outputContainsField(output, field);
      } else {
        signal[field] = extractFieldValue(output, field);
      }
    }

    const validator = new DefaultCompletionValidator();
    const contract = createContract({
      name: contractRow.name,
      acceptanceCriteria: criteria.map((c) => ({
        id: c.id,
        description: c.description,
        type: c.type as 'assertion',
        required: c.required,
        config: c.config,
      })),
    });
    const report = await validator.validate(signal, contract);
    return report.status === 'fulfilled';
  }

  private async buildSupervisorInstructions(
    basePrompt: string | undefined,
    forceWorkerDataAnalysis: boolean,
    workerRows?: import('./db-types.js').WorkerAgentRow[],
  ): Promise<string> {
    const prompts = await this.getPolicyPromptTemplates();
    return buildSupervisorInstructionsPrompt({
      basePrompt,
      forceWorkerDataAnalysis,
      workerRows,
      prompts,
    });
  }

  private async runWithCseSuccessGuard(
    agent: { run: (ctx: ExecutionContext, input: { messages: Message[]; goal: string }) => Promise<AgentResult> },
    ctx: ExecutionContext,
    messages: Message[],
    goal: string,
    enforce: boolean,
  ): Promise<AgentResult> {
    const first = await agent.run(ctx, { messages, goal });
    if (
      !enforce
      || (
        hasSuccessfulCseExecution(first)
        && hasCodeExecutorDelegation(first)
        && hasRenderableAttachmentAnalysisOutput(first, goal)
      )
    ) return first;

    const guardPolicy = await this.getPolicyPromptTemplate(POLICY_PROMPT_HARD_EXECUTION_GUARD, HARD_EXECUTION_GUARD_POLICY);
    const retryGoal = `${goal}\n\n${guardPolicy}`;
    const second = await agent.run(ctx, { messages, goal: retryGoal });
    if (
      hasSuccessfulCseExecution(second)
      && hasCodeExecutorDelegation(second)
      && hasRenderableAttachmentAnalysisOutput(second, retryGoal)
    ) return second;

    return {
      ...second,
      output: '[Execution guard failure] The workflow did not satisfy required execution constraints. A successful cse_run_code run through delegated worker "code_executor" is required, and the final result must be renderable (no sandbox-local file paths, no incomplete insights). Please retry.',
    };
  }

  /** Load pricing from DB, cache for 60 s */
  private async loadPricing(): Promise<Map<string, ModelPricing>> {
    const now = Date.now();
    if (this.pricingCache && now - this.pricingCacheTs < 60_000) return this.pricingCache;
    try {
      const rows = await this.db.listModelPricing();
      const map = new Map<string, ModelPricing>();
      for (const r of rows) {
        if (r.enabled) map.set(r.model_id, { input: r.input_cost_per_1m, output: r.output_cost_per_1m });
      }
      this.pricingCache = map;
      this.pricingCacheTs = now;
      return map;
    } catch {
      return new Map();
    }
  }

  // ── Direct mode: send ───────────────────────────────────────

  async sendMessage(
    userId: string,
    chatId: string,
    content: string,
    opts?: { provider?: string; model?: string; maxTokens?: number; temperature?: number; attachments?: ChatAttachment[] },
  ): Promise<{
    assistantContent: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    cost: number;
    latencyMs: number;
    redaction?: { count: number; types: string[] };
    eval?: { passed: number; failed: number; total: number; score: number };
    steps?: AgentStep[];
    traceId?: string;
    guardrail?: { decision: 'allow' | 'deny' | 'warn'; reason?: string };
    cognitive?: CognitiveCheckSummary;
    policyChecks?: Array<{ tool: string; policy: string; taskType: string; priority: string }>;
    routingDecision?: { provider: string; model: string; reason: string };
    activeSkills?: Array<{ id: string; name: string; category: string; score: number; tools: string[] }>;
    skillTools?: string[];
    enabledTools?: string[];
    skillPromptApplied?: boolean;
    contracts?: PromptContractValidationReport;
    promptStrategy?: PromptStrategyInfo;
    promptResolution?: {
      source: 'base_prompt' | 'prompt_version';
      resolvedVersion: string;
      selectedBy: 'requested_version' | 'experiment' | 'active_flag' | 'latest_published' | 'base_prompt';
      experimentId?: string;
      experimentVariantLabel?: string;
    };
  }> {
    let provider = opts?.provider ?? this.config.defaultProvider;
    let modelId = opts?.model ?? this.config.defaultModel;
    let providerCfg = this.config.providers[provider];
    let routingInfo: { provider: string; model: string; reason: string } | undefined;

    // Try routing from DB policy
    const routed = await this.routeModel(opts);
    if (routed && this.config.providers[routed.provider]) {
      provider = routed.provider;
      modelId = routed.modelId;
      providerCfg = this.config.providers[provider];
      routingInfo = { provider, model: modelId, reason: 'Selected by routing policy' };
    }

    if (!providerCfg) {
      // Fall back to default provider when stored provider isn't configured
      provider = this.config.defaultProvider;
      modelId = this.config.defaultModel;
      providerCfg = this.config.providers[provider];
    }
    if (!providerCfg) {
      // Fall back to first available provider
      const first = Object.entries(this.config.providers)[0];
      if (!first) throw new Error(`No providers configured`);
      [provider, providerCfg] = first;
      modelId = this.config.defaultModel;
    }

    const model = await getOrCreateModel(provider, modelId, providerCfg.apiKey);
    const actor = await this.db.getUserById(userId);
    const userPersona = normalizePersona(actor?.persona, 'user');
    const settings = settingsFromRow(await this.db.getChatSettings(chatId));
    const resolvedSystemPrompt = await this.resolveSystemPrompt(settings);
    const resolvedPrompt = await this.withResponseCardFormatPolicy(resolvedSystemPrompt.content);
    const traceId = randomUUID();
    const ctx = weaveContext({ userId, deadline: Date.now() + 120_000, metadata: { traceId, chatId } });
    const startMs = Date.now();

    const attachments = normalizeAttachments(opts?.attachments);
    const contentWithAttachments = composeUserInput(content, attachments);

    // Redaction
    let processedContent = contentWithAttachments;
    let redactionInfo: { count: number; types: string[] } | undefined;
    if (settings.redactionEnabled) {
      const rd = await this.applyRedaction(ctx, contentWithAttachments, settings.redactionPatterns);
      processedContent = rd.redacted;
      if (rd.wasModified) {
        redactionInfo = { count: rd.detections.length, types: [...new Set(rd.detections.map((d: any) => d.type))] };
      }
    }

    // Discover skills from the user request and auto-enable their associated tools.
    const skillContext = await this.discoverSkillsForInput(processedContent, model, ctx, settings.mode);
    const skillPrompt = applySkillsToPrompt(
      resolvedPrompt,
      skillContext.matches,
      settings.mode === 'direct' ? 'advisory' : 'tool_assisted',
    );
    const enabledTools = Array.from(new Set([...settings.enabledTools, ...skillContext.toolNames]));
    const skillTools = enabledTools.filter((tool) => !settings.enabledTools.includes(tool));
    const activeSkills = skillContext.matches.map((m) => ({
      id: m.skill.id,
      name: m.skill.name,
      description: m.skill.description ?? m.skill.summary,
      category: m.skill.category ?? 'general',
      score: Number(m.score.toFixed(3)),
      tools: [...(m.skill.toolNames ?? [])],
    }));

    // Save user message
    const userMsgId = randomUUID();
    const userMetadata = redactionInfo || attachments.length > 0
      ? JSON.stringify({
          redaction: redactionInfo,
          attachments: attachments.length > 0 ? attachments : undefined,
        })
      : undefined;
    await this.db.addMessage({ id: userMsgId, chatId, role: 'user', content, metadata: userMetadata });

    // Pre-execution guardrails
    const preGuardrail = await this.evaluateGuardrails(chatId, userMsgId, processedContent, 'pre-execution');
    if (preGuardrail.decision === 'deny') {
      const denyContent = preGuardrail.reason || 'Your message was blocked by a guardrail policy.';
      const assistMsgId = randomUUID();
      await this.db.addMessage({
        id: assistMsgId,
        chatId,
        role: 'assistant',
        content: denyContent,
        metadata: JSON.stringify({
          guardrail: { decision: 'deny', reason: preGuardrail.reason },
          cognitive: preGuardrail.cognitive,
        }),
      });
      return {
        assistantContent: denyContent,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        cost: 0,
        latencyMs: Date.now() - startMs,
        redaction: redactionInfo,
        guardrail: { decision: 'deny', reason: preGuardrail.reason },
        cognitive: preGuardrail.cognitive,
      };
    }

    const identityRecall = await this.resolveIdentityRecallFromMemory(userId, processedContent);
    if (identityRecall) {
      const latencyMs = Date.now() - startMs;
      const assistMsgId = randomUUID();
      await this.db.addMessage({
        id: assistMsgId,
        chatId,
        role: 'assistant',
        content: identityRecall,
        metadata: JSON.stringify({
          model: 'memory-recall',
          provider: 'local',
          mode: settings.mode,
          memoryRecall: { deterministic: true, identity: true },
          traceId,
        }),
        tokensUsed: 0,
        cost: 0,
        latencyMs,
      });

      await this.db.recordMetric({
        id: randomUUID(), userId, chatId, type: 'generation', provider: 'local', model: 'memory-recall',
        promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, latencyMs,
      });

      return {
        assistantContent: identityRecall,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        cost: 0,
        latencyMs,
        redaction: redactionInfo,
      };
    }

    // Build conversation
    const history = await this.db.getMessages(chatId);
    const messages = historyToMessages(history);
    patchLatestUserMessage(messages, processedContent);

    // ── Memory recall ──
    const memoryContext = await this.buildMemoryContext(ctx, model, userId, processedContent);
    const augmentedPrompt = memoryContext
      ? (skillPrompt ? `${skillPrompt}\n\n---\n${memoryContext}` : memoryContext)
      : skillPrompt;
    const memorySettings = {
      ...settings,
      enabledTools,
      systemPrompt: augmentedPrompt,
    };

    let assistantContent: string = '';
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let steps: AgentStep[] | undefined;
    let toolCallEvents: ToolCallObservableEvent[] | undefined;
    let cacheHit = false;
    let contractInfo: PromptContractValidationReport | undefined;

    // ── Cache lookup ──
    const allowResponseCache = attachments.length === 0;
    const cachePolicy = allowResponseCache ? await this.resolveActiveCache(settings.mode) : null;
    const cacheKey = this.cacheKeyBuilder.build({ model: modelId, prompt: processedContent });
    if (cachePolicy && !shouldBypass(cachePolicy, processedContent)) {
      const cached = await this.responseCache.get(cacheKey);
      if (cached) {
        assistantContent = (cached as any).content ?? '';
        usage = (cached as any).usage ?? usage;
        cacheHit = true;
      }
    }

    if (!cacheHit) {
    if (settings.mode === 'agent' || settings.mode === 'supervisor') {
      // ── Agent / Supervisor mode ──
      const telemetry = await this.runAgent(ctx, model, userId, chatId, userPersona, messages, processedContent, memorySettings, attachments);
      assistantContent = telemetry.result.output ?? '';
      usage = {
        promptTokens: telemetry.result.usage.totalTokens,  // agent tracks totalTokens only
        completionTokens: 0,
        totalTokens: telemetry.result.usage.totalTokens,
      };
      steps = [...telemetry.result.steps];
      toolCallEvents = telemetry.toolCallEvents;
    } else {
      // ── Direct mode ──
      const request: ModelRequest = {
        messages: augmentedPrompt
          ? [{ role: 'system', content: augmentedPrompt }, ...messages]
          : messages,
        maxTokens: opts?.maxTokens ?? 4096,
        temperature: opts?.temperature,
      };
      const response = await model.generate(ctx, request);
      assistantContent = response.content ?? '';
      usage = { ...response.usage };
    }
    } // end if (!cacheHit)

    // ── Cache store ──
    if (!cacheHit && cachePolicy && !assistantContent.includes('[Execution guard failure]')) {
      await this.responseCache.set(cacheKey, { content: assistantContent!, usage }, cachePolicy.ttlMs);
    }

    contractInfo = await this.validatePromptContracts(assistantContent);


    const latencyMs = Date.now() - startMs;
    const dbPricing = await this.loadPricing();
    const cost = calculateCost(modelId, usage.promptTokens, usage.completionTokens, dbPricing.get(modelId));

    // Record health outcome
    this.recordModelOutcome(modelId, provider, latencyMs, true);

    // Human-task policy checks on tool calls
    const policyChecks = steps ? await this.evaluateTaskPolicies(steps) : undefined;

    // Post-execution guardrails (must run before eval so the decision feeds into the eval score)
    const SUPERVISOR_INTERNAL_TOOLS = new Set(['think', 'plan', 'synthesize', 'reflect', 'log']);
    const toolEvidence = steps
      ?.filter(s => {
        if (s.type !== 'tool_call' && s.type !== 'delegation') return false;
        const result = (s.toolCall?.result ?? s.delegation?.result ?? '') as string;
        if (!result || result === '(Worker returned no output)') return false;
        if (/^\[(PLANNING|REASONING|SYNTHESIS|REFLECTION)\]/.test(result)) return false;
        if (s.type === 'tool_call' && SUPERVISOR_INTERNAL_TOOLS.has(s.toolCall?.name ?? '')) return false;
        return true;
      })
      .map(s => (s.toolCall?.result ?? s.delegation?.result ?? '') as string)
      .join(' ') || undefined;
    const postGuardrail = await this.evaluateGuardrails(chatId, null, assistantContent, 'post-execution', {
      userInput: processedContent,
      assistantOutput: assistantContent,
      toolEvidence,
    });
    const guardrailInfo = preGuardrail.decision !== 'allow'
      ? { decision: preGuardrail.decision as 'allow' | 'deny' | 'warn', reason: preGuardrail.reason }
      : postGuardrail.decision !== 'allow'
      ? { decision: postGuardrail.decision as 'allow' | 'deny' | 'warn', reason: postGuardrail.reason }
      : undefined;

    // Eval — pass the overall guardrail decision so the score reflects grounding/sycophancy warnings
    const overallGuardrailDecision = guardrailInfo?.decision ?? 'allow';
    let evalInfo: { passed: number; failed: number; total: number; score: number } | undefined;
    evalInfo = await this.runPostEval(ctx, userId, chatId, processedContent, assistantContent, latencyMs, cost, overallGuardrailDecision);

    // Save assistant message
    const assistMsgId = randomUUID();
    await this.db.addMessage({
      id: assistMsgId,
      chatId,
      role: 'assistant',
      content: assistantContent ?? '',
      metadata: JSON.stringify({
        model: modelId, provider,
        mode: settings.mode,
        agentName: settings.mode === 'supervisor' ? 'geneweave-supervisor' : settings.mode === 'agent' ? 'geneweave-agent' : undefined,
        systemPrompt: memorySettings.systemPrompt || undefined,
        enabledTools: memorySettings.enabledTools.length ? memorySettings.enabledTools : undefined,
        activeSkills: activeSkills.length ? activeSkills : undefined,
        skillTools: skillTools.length ? skillTools : undefined,
        skillPromptApplied: activeSkills.length > 0 ? true : undefined,
        redactionEnabled: settings.redactionEnabled || undefined,
        steps: steps ? steps.map(s => ({ type: s.type, content: s.content, toolCall: s.toolCall, delegation: s.delegation, durationMs: s.durationMs })) : undefined,
        eval: evalInfo,
        guardrail: guardrailInfo,
        cognitive: postGuardrail.cognitive,
        policyChecks: policyChecks?.length ? policyChecks : undefined,
        promptContracts: contractInfo,
        promptStrategy: resolvedSystemPrompt.strategy,
        promptResolution: resolvedSystemPrompt.resolution,
        traceId,
      }),
      tokensUsed: usage.totalTokens,
      cost,
      latencyMs,
    });

    // Persist memory before returning so cross-chat recall is immediately available.
    try {
      await this.saveToMemory(ctx, model, userId, chatId, processedContent, assistantContent);
    } catch {
      // Keep chat success path resilient when memory persistence fails.
    }

    // Record metric
    await this.db.recordMetric({
      id: randomUUID(), userId, chatId, type: 'generation', provider, model: modelId,
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens, cost, latencyMs,
    });

    // Record traces
    await this.recordTraceSpans(
      userId,
      chatId,
      assistMsgId,
      traceId,
      settings.mode,
      startMs,
      latencyMs,
      steps,
      toolCallEvents,
      this.buildCapabilityTelemetrySnapshots(
        settings.mode,
        resolvedSystemPrompt.telemetry,
        activeSkills,
        memorySettings.enabledTools,
      ),
    );

    return {
      assistantContent,
      usage,
      cost,
      latencyMs,
      redaction: redactionInfo,
      eval: evalInfo,
      steps,
      traceId,
      guardrail: guardrailInfo,
      cognitive: postGuardrail.cognitive,
      policyChecks,
      routingDecision: routingInfo,
      activeSkills,
      skillTools,
      enabledTools: memorySettings.enabledTools,
      skillPromptApplied: activeSkills.length > 0,
      contracts: contractInfo,
      promptStrategy: resolvedSystemPrompt.strategy,
      promptResolution: resolvedSystemPrompt.resolution,
    };
  }

  // ── Stream mode ─────────────────────────────────────────────

  async streamMessage(
    res: ServerResponse,
    userId: string,
    chatId: string,
    content: string,
    opts?: { provider?: string; model?: string; maxTokens?: number; temperature?: number; attachments?: ChatAttachment[] },
  ): Promise<void> {
    let provider = opts?.provider ?? this.config.defaultProvider;
    let modelId = opts?.model ?? this.config.defaultModel;
    let providerCfg = this.config.providers[provider];

    // Try routing from DB policy
    const routed = await this.routeModel(opts);
    if (routed && this.config.providers[routed.provider]) {
      provider = routed.provider;
      modelId = routed.modelId;
      providerCfg = this.config.providers[provider];
    }

    if (!providerCfg) {
      // Fall back to default provider when stored provider isn't configured
      provider = this.config.defaultProvider;
      modelId = this.config.defaultModel;
      providerCfg = this.config.providers[provider];
    }
    if (!providerCfg) {
      // Fall back to first available provider
      const first = Object.entries(this.config.providers)[0];
      if (!first) throw new Error(`No providers configured`);
      [provider, providerCfg] = first;
      modelId = this.config.defaultModel;
    }

    const model = await getOrCreateModel(provider, modelId, providerCfg.apiKey);
    const actor = await this.db.getUserById(userId);
    const userPersona = normalizePersona(actor?.persona, 'user');
    const settings = settingsFromRow(await this.db.getChatSettings(chatId));
    const resolvedSystemPrompt = await this.resolveSystemPrompt(settings);
    const resolvedPrompt = await this.withResponseCardFormatPolicy(resolvedSystemPrompt.content);
    const traceId = randomUUID();
    const ctx = weaveContext({ userId, deadline: Date.now() + 120_000, metadata: { traceId, chatId } });

    const attachments = normalizeAttachments(opts?.attachments);
    const contentWithAttachments = composeUserInput(content, attachments);

    // Redaction
    let processedContent = contentWithAttachments;
    let redactionInfo: { count: number; types: string[] } | undefined;
    if (settings.redactionEnabled) {
      const rd = await this.applyRedaction(ctx, contentWithAttachments, settings.redactionPatterns);
      processedContent = rd.redacted;
      if (rd.wasModified) {
        redactionInfo = { count: rd.detections.length, types: [...new Set(rd.detections.map((d: any) => d.type))] };
      }
    }

    // Discover skills from the user request and auto-enable their associated tools.
    const streamSkillContext = await this.discoverSkillsForInput(processedContent, model, ctx, settings.mode);
    const streamSkillPrompt = applySkillsToPrompt(
      resolvedPrompt,
      streamSkillContext.matches,
      settings.mode === 'direct' ? 'advisory' : 'tool_assisted',
    );
    const streamEnabledTools = Array.from(new Set([...settings.enabledTools, ...streamSkillContext.toolNames]));
    const streamSkillTools = streamEnabledTools.filter((tool) => !settings.enabledTools.includes(tool));
    const streamActiveSkills = streamSkillContext.matches.map((m) => ({
      id: m.skill.id,
      name: m.skill.name,
      description: m.skill.description ?? m.skill.summary,
      category: m.skill.category ?? 'general',
      score: Number(m.score.toFixed(3)),
      tools: [...(m.skill.toolNames ?? [])],
    }));

    // Save user message
    const userMsgId = randomUUID();
    const userMetadata = redactionInfo || attachments.length > 0
      ? JSON.stringify({
          redaction: redactionInfo,
          attachments: attachments.length > 0 ? attachments : undefined,
        })
      : undefined;
    await this.db.addMessage({ id: userMsgId, chatId, role: 'user', content, metadata: userMetadata });

    // Pre-execution guardrails
    const preGuardrail = await this.evaluateGuardrails(chatId, userMsgId, processedContent, 'pre-execution');
    if (preGuardrail.decision === 'deny') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const denyContent = preGuardrail.reason || 'Your message was blocked by a guardrail policy.';
      res.write(`data: ${JSON.stringify({ type: 'text', text: denyContent })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'guardrail', decision: 'deny', reason: preGuardrail.reason })}\n\n`);
      if (preGuardrail.cognitive) {
        res.write(`data: ${JSON.stringify({ type: 'cognitive', ...preGuardrail.cognitive })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: 'done', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, cost: 0, latencyMs: 0 })}\n\n`);
      res.end();
      await this.db.addMessage({
        id: randomUUID(),
        chatId,
        role: 'assistant',
        content: denyContent,
        metadata: JSON.stringify({ guardrail: { decision: 'deny', reason: preGuardrail.reason }, cognitive: preGuardrail.cognitive }),
      });
      return;
    }

    const identityRecall = await this.resolveIdentityRecallFromMemory(userId, processedContent);
    if (identityRecall) {
      const latencyMs = 0;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (redactionInfo) {
        res.write(`data: ${JSON.stringify({ type: 'redaction', ...redactionInfo })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ type: 'text', text: identityRecall })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'done',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        cost: 0,
        latencyMs,
        model: 'memory-recall',
        provider: 'local',
        mode: settings.mode,
      })}\n\n`);

      await this.db.addMessage({
        id: randomUUID(),
        chatId,
        role: 'assistant',
        content: identityRecall,
        metadata: JSON.stringify({
          model: 'memory-recall',
          provider: 'local',
          streamed: true,
          mode: settings.mode,
          memoryRecall: { deterministic: true, identity: true },
          traceId,
        }),
        tokensUsed: 0,
        cost: 0,
        latencyMs,
      });

      await this.db.recordMetric({
        id: randomUUID(), userId, chatId, type: 'generation', provider: 'local', model: 'memory-recall',
        promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, latencyMs,
      });

      res.end();
      return;
    }

    // Build conversation
    const history = await this.db.getMessages(chatId);
    const messages = historyToMessages(history);
    patchLatestUserMessage(messages, processedContent);

    // ── Memory recall ──
    const streamMemoryContext = await this.buildMemoryContext(ctx, model, userId, processedContent);
    const streamAugmentedPrompt = streamMemoryContext
      ? (streamSkillPrompt ? `${streamSkillPrompt}\n\n---\n${streamMemoryContext}` : streamMemoryContext)
      : streamSkillPrompt;
    const streamMemorySettings = {
      ...settings,
      enabledTools: streamEnabledTools,
      systemPrompt: streamAugmentedPrompt,
    };

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send redaction event
    if (redactionInfo) {
      res.write(`data: ${JSON.stringify({ type: 'redaction', ...redactionInfo })}\n\n`);
    }

    const startMs = Date.now();
    let fullText = '';
    let finalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let steps: AgentStep[] = [];
    let toolCallEvents: ToolCallObservableEvent[] = [];
    let streamContractInfo: PromptContractValidationReport | undefined;

    try {
      if (settings.mode === 'agent' || settings.mode === 'supervisor') {
        // ── Agent / Supervisor streaming ──
        const telemetry = await this.streamAgent(res, ctx, model, userId, chatId, userPersona, messages, processedContent, streamMemorySettings, attachments);
        fullText = telemetry.result.output ?? '';
        finalUsage = { promptTokens: telemetry.result.usage.totalTokens, completionTokens: 0, totalTokens: telemetry.result.usage.totalTokens };
        steps = [...telemetry.result.steps];
        toolCallEvents = telemetry.toolCallEvents;
      } else {
        // ── Direct streaming ──
        const request: ModelRequest = {
          messages: streamAugmentedPrompt
            ? [{ role: 'system', content: streamAugmentedPrompt }, ...messages]
            : messages,
          maxTokens: opts?.maxTokens ?? 4096,
          temperature: opts?.temperature,
          stream: true,
        };

        if (model.stream) {
          const stream = model.stream(ctx, request);
          for await (const chunk of stream) {
            if (chunk.type === 'text' && chunk.text) {
              fullText += chunk.text;
              res.write(`data: ${JSON.stringify({ type: 'text', text: chunk.text })}\n\n`);
            } else if (chunk.type === 'reasoning' && chunk.reasoning) {
              res.write(`data: ${JSON.stringify({ type: 'reasoning', text: chunk.reasoning })}\n\n`);
            } else if (chunk.type === 'usage' && chunk.usage) {
              finalUsage = { promptTokens: chunk.usage.promptTokens, completionTokens: chunk.usage.completionTokens, totalTokens: chunk.usage.totalTokens };
            } else if (chunk.type === 'done') {
              break;
            }
          }
        } else {
          const response = await model.generate(ctx, request);
          fullText = response.content;
          finalUsage = { ...response.usage };
          res.write(`data: ${JSON.stringify({ type: 'text', text: response.content })}\n\n`);
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Stream error';
      res.write(`data: ${JSON.stringify({ type: 'error', error: errMsg })}\n\n`);
    }

    const latencyMs = Date.now() - startMs;
    const streamDbPricing = await this.loadPricing();
    const cost = calculateCost(modelId, finalUsage.promptTokens, finalUsage.completionTokens, streamDbPricing.get(modelId));

    // Record health outcome
    this.recordModelOutcome(modelId, provider, latencyMs, true);

    // Human-task policy checks on tool calls
    const policyChecks = steps.length ? await this.evaluateTaskPolicies(steps) : undefined;
    if (policyChecks?.length) {
      res.write(`data: ${JSON.stringify({ type: 'policy_checks', checks: policyChecks })}\n\n`);
    }

    // Post-execution guardrails (must run before eval so the decision feeds into the eval score)
    const STREAM_SUPERVISOR_INTERNAL_TOOLS = new Set(['think', 'plan', 'synthesize', 'reflect', 'log']);
    const streamToolEvidence = steps
      ?.filter(s => {
        if (s.type !== 'tool_call' && s.type !== 'delegation') return false;
        const result = (s.toolCall?.result ?? s.delegation?.result ?? '') as string;
        if (!result || result === '(Worker returned no output)') return false;
        if (/^\[(PLANNING|REASONING|SYNTHESIS|REFLECTION)\]/.test(result)) return false;
        if (s.type === 'tool_call' && STREAM_SUPERVISOR_INTERNAL_TOOLS.has(s.toolCall?.name ?? '')) return false;
        return true;
      })
      .map(s => (s.toolCall?.result ?? s.delegation?.result ?? '') as string)
      .join(' ') || undefined;
    const postGuardrail = await this.evaluateGuardrails(chatId, null, fullText, 'post-execution', {
      userInput: processedContent,
      assistantOutput: fullText,
      toolEvidence: streamToolEvidence,
    });
    if (postGuardrail.cognitive) {
      res.write(`data: ${JSON.stringify({ type: 'cognitive', ...postGuardrail.cognitive })}\n\n`);
    }
    if (postGuardrail.decision !== 'allow') {
      res.write(`data: ${JSON.stringify({ type: 'guardrail', decision: postGuardrail.decision, reason: postGuardrail.reason })}\n\n`);
    }

    // Eval — pass guardrail decision so the score reflects grounding/sycophancy warnings
    const streamGuardrailDecision = postGuardrail.decision as 'allow' | 'warn' | 'deny';
    const evalInfo = await this.runPostEval(ctx, userId, chatId, processedContent, fullText, latencyMs, cost, streamGuardrailDecision);
    if (evalInfo) {
      res.write(`data: ${JSON.stringify({ type: 'eval', ...evalInfo })}\n\n`);
    }

    streamContractInfo = await this.validatePromptContracts(fullText);
    if (streamContractInfo) {
      res.write(`data: ${JSON.stringify({ type: 'contracts', ...streamContractInfo })}\n\n`);
    }

    // Done event
    res.write(`data: ${JSON.stringify({
      type: 'done',
      usage: finalUsage,
      cost,
      latencyMs,
      model: modelId,
      provider,
      mode: settings.mode,
      activeSkills: streamActiveSkills,
      skillTools: streamSkillTools,
      enabledTools: streamMemorySettings.enabledTools,
      skillPromptApplied: streamActiveSkills.length > 0,
      steps: steps.map(s => ({ type: s.type, content: s.content, toolCall: s.toolCall, delegation: s.delegation, durationMs: s.durationMs })),
      cognitive: postGuardrail.cognitive,
      contracts: streamContractInfo,
      promptStrategy: resolvedSystemPrompt.strategy,
      promptResolution: resolvedSystemPrompt.resolution,
      traceId,
    })}\n\n`);

    // Persist before closing the stream so immediate follow-up chats can recall memory.
    const assistMsgId = randomUUID();
    await this.db.addMessage({
      id: assistMsgId, chatId, role: 'assistant', content: fullText,
      metadata: JSON.stringify({
        model: modelId, provider, streamed: true, mode: settings.mode,
        agentName: settings.mode === 'supervisor' ? 'geneweave-supervisor' : settings.mode === 'agent' ? 'geneweave-agent' : undefined,
        systemPrompt: streamMemorySettings.systemPrompt || undefined,
        enabledTools: streamMemorySettings.enabledTools.length ? streamMemorySettings.enabledTools : undefined,
        activeSkills: streamActiveSkills.length ? streamActiveSkills : undefined,
        skillTools: streamSkillTools.length ? streamSkillTools : undefined,
        skillPromptApplied: streamActiveSkills.length > 0 ? true : undefined,
        redactionEnabled: settings.redactionEnabled || undefined,
        steps: steps.length ? steps.map(s => ({ type: s.type, content: s.content, toolCall: s.toolCall, delegation: s.delegation, durationMs: s.durationMs })) : undefined,
        eval: evalInfo,
        guardrail: postGuardrail.decision !== 'allow' ? { decision: postGuardrail.decision, reason: postGuardrail.reason } : undefined,
        cognitive: postGuardrail.cognitive,
        policyChecks: policyChecks?.length ? policyChecks : undefined,
        promptContracts: streamContractInfo,
        promptStrategy: resolvedSystemPrompt.strategy,
        promptResolution: resolvedSystemPrompt.resolution,
        traceId,
      }),
      tokensUsed: finalUsage.totalTokens, cost, latencyMs,
    });

    // Persist memory before completing request lifecycle to reduce write/read races across chats.
    try {
      await this.saveToMemory(ctx, model, userId, chatId, processedContent, fullText);
    } catch {
      // Keep chat success path resilient when memory persistence fails.
    }

    await this.db.recordMetric({
      id: randomUUID(), userId, chatId, type: 'generation', provider, model: modelId,
      promptTokens: finalUsage.promptTokens, completionTokens: finalUsage.completionTokens,
      totalTokens: finalUsage.totalTokens, cost, latencyMs,
    });

    await this.recordTraceSpans(userId, chatId, assistMsgId, traceId, settings.mode, startMs, latencyMs, steps, toolCallEvents);
    await this.recordTraceSpans(
      userId,
      chatId,
      assistMsgId,
      traceId,
      settings.mode,
      startMs,
      latencyMs,
      steps,
      toolCallEvents,
      this.buildCapabilityTelemetrySnapshots(
        settings.mode,
        resolvedSystemPrompt.telemetry,
        streamActiveSkills,
        streamMemorySettings.enabledTools,
      ),
    );
    res.end();
  }

  private async validatePromptContracts(output: string): Promise<PromptContractValidationReport | undefined> {
    if (!output.trim()) return undefined;
    try {
      const rows = await this.db.listPromptContracts();
      const enabledRows = rows.filter((row) => row.enabled);
      if (enabledRows.length === 0) return undefined;

      const parsed = enabledRows
        .map((row) => ({
          row,
          contract: contractFromRecord({
            id: row.id,
            key: row.key,
            name: row.name,
            description: row.description ?? '',
            contract_type: row.contract_type,
            schema: row.schema ?? undefined,
            config: row.config,
            enabled: row.enabled,
          }),
        }))
        .filter((entry): entry is { row: typeof enabledRows[number]; contract: NonNullable<ReturnType<typeof contractFromRecord>> } => !!entry.contract);

      if (parsed.length === 0) return undefined;

      const registry = new InMemoryContractRegistry(parsed.map((entry) => entry.contract));
      const results: PromptContractCheckResult[] = parsed.map(({ row }) => {
        const contract = registry.get(row.key);
        if (!contract) {
          return {
            key: row.key,
            name: row.name,
            contractType: row.contract_type,
            valid: false,
            severity: 'error',
            message: 'Contract could not be loaded from registry',
            errorCount: 1,
          };
        }
        const validation = validateContract(output, contract);
        return {
          key: row.key,
          name: row.name,
          contractType: row.contract_type,
          valid: validation.valid,
          severity: validation.severity,
          message: validation.message,
          errorCount: validation.errors.length,
          repairSuggestion: validation.repairSuggestion,
        };
      });

      const summary: PromptContractValidationSummary = {
        total: results.length,
        passed: results.filter((r) => r.valid).length,
        failed: results.filter((r) => !r.valid).length,
        error: results.filter((r) => r.severity === 'error').length,
        warning: results.filter((r) => r.severity === 'warning').length,
        info: results.filter((r) => r.severity === 'info').length,
      };

      return { summary, results };
    } catch {
      return undefined;
    }
  }

  // ── Enterprise tools loader ─────────────────────────────────

  /**
   * Auto-refresh OAuth2 token if it expires within 60 seconds.
   * Mutates the row's access_token in-place and persists to DB.
   */
  private async refreshTokenIfNeeded(row: import('./db-types.js').EnterpriseConnectorRow): Promise<void> {
    if (row.auth_type !== 'oauth2' || !row.refresh_token || !row.token_expires_at) return;
    const expiresAt = new Date(row.token_expires_at).getTime();
    const now = Date.now();
    // Refresh if token expires within 60 seconds
    if (expiresAt - now > 60_000) return;

    const authConfig = row.auth_config ? (JSON.parse(row.auth_config) as Record<string, string>) : {};
    const clientId = authConfig['clientId'] ?? authConfig['client_id'];
    const clientSecret = authConfig['clientSecret'] ?? authConfig['client_secret'];
    if (!clientId || !clientSecret || !row.base_url) return;

    console.log(`[chat] OAuth token for ${row.connector_type}/${row.name} expires soon — refreshing...`);
    const provider = new ServiceNowProvider();
    const result = await provider.refreshOAuthToken(row.base_url, clientId, clientSecret, row.refresh_token);
    if (!result) {
      console.error(`[chat] Token refresh failed for connector ${row.id}`);
      return;
    }

    const newExpiresAt = new Date(now + result.expiresIn * 1000).toISOString();
    await this.db.updateEnterpriseConnector(row.id, {
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      token_expires_at: newExpiresAt,
    });
    // Mutate the row so callers pick up the fresh token
    row.access_token = result.accessToken;
    row.refresh_token = result.refreshToken;
    row.token_expires_at = newExpiresAt;
    console.log(`[chat] Token refreshed for ${row.connector_type}/${row.name}, expires ${newExpiresAt}`);
  }

  private async loadEnterpriseTools(): Promise<import('@weaveintel/core').Tool[]> {
    try {
      const rows = await this.db.listEnterpriseConnectors();
      const enabled = rows.filter((r) => r.enabled === 1 && r.status === 'connected');
      if (enabled.length === 0) return [];

      // Auto-refresh expired OAuth tokens before building configs
      await Promise.all(enabled.map((r) => this.refreshTokenIfNeeded(r)));

      const configs: EnterpriseConnectorConfig[] = enabled.map((row) => {
        const authConfig: Record<string, string> = row.auth_config
          ? (JSON.parse(row.auth_config) as Record<string, string>)
          : {};
        // Inject access_token from the DB column into authConfig for oauth2/bearer
        if (row.access_token && !authConfig['accessToken']) {
          authConfig['accessToken'] = row.access_token;
        }
        return {
          name: row.name,
          type: row.connector_type,
          enabled: true,
          baseUrl: row.base_url ?? '',
          authType: (row.auth_type ?? 'bearer') as EnterpriseConnectorConfig['authType'],
          authConfig,
          options: row.options ? (JSON.parse(row.options) as Record<string, string>) : undefined,
        };
      });

      return createEnterpriseTools(configs, undefined, { includeExtended: false });
    } catch (err) {
      console.error('[chat] Failed to load enterprise tools:', err);
      return [];
    }
  }

  private async loadEnterpriseToolGroups(): Promise<EnterpriseToolGroup[]> {
    try {
      const rows = await this.db.listEnterpriseConnectors();
      const enabled = rows.filter((r) => r.enabled === 1 && r.status === 'connected');
      if (enabled.length === 0) return [];

      // Auto-refresh expired OAuth tokens before building configs
      await Promise.all(enabled.map((r) => this.refreshTokenIfNeeded(r)));

      const configs: EnterpriseConnectorConfig[] = enabled.map((row) => {
        const authConfig: Record<string, string> = row.auth_config
          ? (JSON.parse(row.auth_config) as Record<string, string>)
          : {};
        if (row.access_token && !authConfig['accessToken']) {
          authConfig['accessToken'] = row.access_token;
        }
        return {
          name: row.name,
          type: row.connector_type,
          enabled: true,
          baseUrl: row.base_url ?? '',
          authType: (row.auth_type ?? 'bearer') as EnterpriseConnectorConfig['authType'],
          authConfig,
          options: row.options ? (JSON.parse(row.options) as Record<string, string>) : undefined,
        };
      });

      return createEnterpriseToolGroups(configs);
    } catch (err) {
      console.error('[chat] Failed to load enterprise tool groups:', err);
      return [];
    }
  }

  // ── Agent execution (non-streaming) ─────────────────────────

  private async runAgent(
    ctx: ExecutionContext,
    model: Model,
    userId: string,
    chatId: string,
    userPersona: string,
    messages: Message[],
    userContent: string,
    settings: ChatSettings,
    attachments?: ChatAttachment[],
  ): Promise<AgentRunTelemetry> {
    const enterpriseToolGroups = await this.loadEnterpriseToolGroups();
    const hasEnterprise = enterpriseToolGroups.length > 0;
    // Flat enterprise tools for backward compat (base tools only, no extended)
    const enterpriseTools = hasEnterprise ? await this.loadEnterpriseTools() : [];
    const toolOptions: ToolRegistryOptions = {
      ...this.toolOptions,
      defaultTimezone: settings.timezone,
      currentUserId: userId,
      currentChatId: chatId,
      currentAttachments: attachments,
      actorPersona: userPersona,
      memoryRecall: async ({ userId: recallUserId, query, limit }) => {
        const boundedLimit = Math.max(1, Math.min(20, limit ?? 5));
        const [semantic, entityRows] = await Promise.all([
          this.db.searchSemanticMemory({ userId: recallUserId, query, limit: boundedLimit }),
          this.db.searchEntities(recallUserId, query),
        ]);
        return {
          semantic: semantic.map((m) => ({ content: m.content, source: m.source })),
          entities: entityRows.map((e) => ({
            entityType: e.entity_type,
            entityName: e.entity_name,
            facts: (this.safeParseJson(e.facts) as Record<string, unknown>) ?? {},
          })),
        };
      },
    };
    const customTools = enterpriseTools.length > 0 ? enterpriseTools : undefined;
    const tools = settings.enabledTools.length
      ? createToolRegistry(settings.enabledTools, customTools, toolOptions)
      : customTools?.length ? createToolRegistry([], customTools, toolOptions) : undefined;

    const agentBus = weaveEventBus();
    const toolCallObserver = this.observeToolCallEvents(agentBus);

    try {
      let agent;
      const forceWorkerDataAnalysis = shouldForceWorkerDataAnalysis(userContent, attachments);
      const forceWorkerRequirement = await this.getPolicyPromptTemplate(
        POLICY_PROMPT_FORCED_WORKER_REQUIREMENT,
        FORCED_WORKER_REQUIREMENT,
      );
      const effectiveGoal = forceWorkerDataAnalysis
        ? `${userContent}\n\n${forceWorkerRequirement}`
        : userContent;

      // Load DB-driven worker agents for supervisor mode
      const dbWorkerRows = (settings.mode === 'supervisor' || (settings.mode === 'agent' && hasEnterprise))
        ? await this.db.listEnabledWorkerAgents()
        : [];

      const routedGoal = effectiveGoal;

      // Auto-upgrade to supervisor when enterprise tools are available
      if (settings.mode === 'supervisor' || (settings.mode === 'agent' && hasEnterprise)) {
        const baseWorkers = settings.workers.length > 0
          ? settings.workers.map((w) => ({
              name: w.name,
              description: w.description,
              systemPrompt: applyTemporalToolPolicy({
                basePrompt: undefined,
                toolNames: w.tools,
                temporalToolPolicy: TEMPORAL_TOOL_POLICY,
              }),
              model,
              tools: w.tools.length
                ? createToolRegistry(w.tools, customTools, { ...toolOptions, actorPersona: normalizePersona(w.persona, 'agent') })
                : customTools?.length
                  ? createToolRegistry([], customTools, { ...toolOptions, actorPersona: normalizePersona(w.persona, 'agent') })
                  : undefined,
            }))
          : this.buildWorkersFromDb(dbWorkerRows, model, toolOptions, customTools);
        // Build enterprise domain workers from tool groups
        const enterpriseWorkers = await Promise.all(enterpriseToolGroups.map(async (g) => {
          const registry = createToolRegistry([], g.tools, { ...toolOptions, actorPersona: 'agent_researcher' });
          return {
            name: g.name,
            description: g.description,
            systemPrompt: await this.renderPolicyPromptTemplate(
              POLICY_PROMPT_ENTERPRISE_WORKER_SYSTEM,
              ENTERPRISE_WORKER_SYSTEM_PROMPT,
              { description: g.description },
            ),
            model,
            tools: registry,
          };
        }));
        const allWorkers = [...baseWorkers, ...enterpriseWorkers];
        console.log(`[chat] Supervisor with ${allWorkers.length} workers (${baseWorkers.length} base + ${enterpriseWorkers.length} enterprise)`);
        const supervisorCseTools = forceWorkerDataAnalysis
          ? undefined
          : createToolRegistry(
              ['cse_run_code', 'cse_session_status', 'cse_end_session'],
              undefined,
              { ...toolOptions, actorPersona: 'agent_worker' },
            );

        const supervisorInstructions = await this.buildSupervisorInstructions(settings.systemPrompt, forceWorkerDataAnalysis, dbWorkerRows);

        agent = weaveSupervisor({
          model,
          workers: allWorkers,
          maxSteps: 20,
          name: 'geneweave-supervisor',
          instructions: supervisorInstructions,
          additionalTools: supervisorCseTools,
          bus: agentBus,
        });
      } else {
        const policyPrompt = await this.withResponseCardFormatPolicy(applyTemporalToolPolicy({
          basePrompt: settings.systemPrompt,
          toolNames: settings.enabledTools,
          temporalToolPolicy: TEMPORAL_TOOL_POLICY,
        }));
        agent = weaveAgent({
          model,
          tools,
          systemPrompt: policyPrompt,
          maxSteps: 15,
          name: 'geneweave-agent',
          bus: agentBus,
        });
      }

      const result = await this.runWithCseSuccessGuard(
        agent,
        ctx,
        messages,
        routedGoal,
        forceWorkerDataAnalysis,
      );
      return { result, toolCallEvents: toolCallObserver.events };
    } finally {
      toolCallObserver.dispose();
    }
  }

  // ── Agent streaming ─────────────────────────────────────────

  private async streamAgent(
    res: ServerResponse,
    ctx: ExecutionContext,
    model: Model,
    userId: string,
    chatId: string,
    userPersona: string,
    messages: Message[],
    userContent: string,
    settings: ChatSettings,
    attachments?: ChatAttachment[],
  ): Promise<AgentRunTelemetry> {
    const enterpriseToolGroups = await this.loadEnterpriseToolGroups();
    const hasEnterprise = enterpriseToolGroups.length > 0;
    const enterpriseTools = hasEnterprise ? await this.loadEnterpriseTools() : [];
    const toolOptions: ToolRegistryOptions = {
      ...this.toolOptions,
      defaultTimezone: settings.timezone,
      currentUserId: userId,
      currentChatId: chatId,
      currentAttachments: attachments,
      actorPersona: userPersona,
      memoryRecall: async ({ userId: recallUserId, query, limit }) => {
        const boundedLimit = Math.max(1, Math.min(20, limit ?? 5));
        const [semantic, entityRows] = await Promise.all([
          this.db.searchSemanticMemory({ userId: recallUserId, query, limit: boundedLimit }),
          this.db.searchEntities(recallUserId, query),
        ]);
        return {
          semantic: semantic.map((m) => ({ content: m.content, source: m.source })),
          entities: entityRows.map((e) => ({
            entityType: e.entity_type,
            entityName: e.entity_name,
            facts: (this.safeParseJson(e.facts) as Record<string, unknown>) ?? {},
          })),
        };
      },
    };
    const customTools = enterpriseTools.length > 0 ? enterpriseTools : undefined;
    const tools = settings.enabledTools.length
      ? createToolRegistry(settings.enabledTools, customTools, toolOptions)
      : customTools?.length ? createToolRegistry([], customTools, toolOptions) : undefined;

    // Create event bus to capture sub-agent events (e.g. screenshots from workers)
    const agentBus = weaveEventBus();
    const toolCallObserver = this.observeToolCallEvents(agentBus);
    let screenshotUnsub: (() => void) | undefined;

    // Listen for browser_screenshot tool results from any worker and forward via SSE
    screenshotUnsub = agentBus.on(EventTypes.ToolCallEnd, (event) => {
      if (event.data['tool'] === 'browser_screenshot' && typeof event.data['result'] === 'string') {
        try {
          const parsed = JSON.parse(event.data['result'] as string);
          if (parsed.base64) {
            res.write(`data: ${JSON.stringify({ type: 'screenshot', base64: parsed.base64, format: parsed.format || 'png' })}\n\n`);
          }
        } catch { /* not JSON or no base64 — ignore */ }
      }
    });

    try {
      const forceWorkerDataAnalysis = shouldForceWorkerDataAnalysis(userContent, attachments);
      const forceWorkerRequirement = await this.getPolicyPromptTemplate(
        POLICY_PROMPT_FORCED_WORKER_REQUIREMENT,
        FORCED_WORKER_REQUIREMENT,
      );
      const effectiveGoal = forceWorkerDataAnalysis
        ? `${userContent}\n\n${forceWorkerRequirement}`
        : userContent;
      const dbWorkerRows = (settings.mode === 'supervisor' || (settings.mode === 'agent' && hasEnterprise))
        ? await this.db.listEnabledWorkerAgents()
        : [];
      const routedGoal = effectiveGoal;
      let agent;
      if (settings.mode === 'supervisor' || (settings.mode === 'agent' && hasEnterprise)) {
        const baseWorkers = settings.workers.length > 0
          ? settings.workers.map((w) => ({
              name: w.name,
              description: w.description,
              systemPrompt: applyTemporalToolPolicy({
                basePrompt: undefined,
                toolNames: w.tools,
                temporalToolPolicy: TEMPORAL_TOOL_POLICY,
              }),
              model,
              tools: w.tools.length
                ? createToolRegistry(w.tools, customTools, { ...toolOptions, actorPersona: normalizePersona(w.persona, 'agent') })
                : customTools?.length
                  ? createToolRegistry([], customTools, { ...toolOptions, actorPersona: normalizePersona(w.persona, 'agent') })
                  : undefined,
            }))
          : this.buildWorkersFromDb(dbWorkerRows, model, toolOptions, customTools);
        const enterpriseWorkers = await Promise.all(enterpriseToolGroups.map(async (g) => {
          const registry = createToolRegistry([], g.tools, { ...toolOptions, actorPersona: 'agent_researcher' });
          return {
            name: g.name,
            description: g.description,
            systemPrompt: await this.renderPolicyPromptTemplate(
              POLICY_PROMPT_ENTERPRISE_WORKER_SYSTEM,
              ENTERPRISE_WORKER_SYSTEM_PROMPT,
              { description: g.description },
            ),
            model,
            tools: registry,
          };
        }));
        const allWorkers = [...baseWorkers, ...enterpriseWorkers];
        const supervisorCseToolsStream = forceWorkerDataAnalysis
          ? undefined
          : createToolRegistry(
              ['cse_run_code', 'cse_session_status', 'cse_end_session'],
              undefined,
              { ...toolOptions, actorPersona: 'agent_worker' },
            );

        const supervisorInstructions = await this.buildSupervisorInstructions(settings.systemPrompt, forceWorkerDataAnalysis, dbWorkerRows);
        agent = weaveSupervisor({
          model,
          workers: allWorkers,
          maxSteps: 20,
          name: 'geneweave-supervisor',
          instructions: supervisorInstructions,
          additionalTools: supervisorCseToolsStream,
          bus: agentBus,
        });
      } else {
        const policyPrompt = await this.withResponseCardFormatPolicy(applyTemporalToolPolicy({
          basePrompt: settings.systemPrompt,
          toolNames: settings.enabledTools,
          temporalToolPolicy: TEMPORAL_TOOL_POLICY,
        }));
        agent = weaveAgent({
          model,
          tools,
          systemPrompt: policyPrompt,
          maxSteps: 15,
          name: 'geneweave-agent',
        });
      }

    if (forceWorkerDataAnalysis) {
      const guarded = await this.runWithCseSuccessGuard(agent, ctx, messages, routedGoal, true);
      res.write(`data: ${JSON.stringify({ type: 'text', text: guarded.output })}\n\n`);
      for (const step of guarded.steps) {
        res.write(`data: ${JSON.stringify({
          type: 'step',
          step: { index: step.index, type: step.type, content: step.content, toolCall: step.toolCall, delegation: step.delegation, durationMs: step.durationMs },
          phase: 'step_end',
        })}\n\n`);
      }
      return { result: guarded, toolCallEvents: toolCallObserver.events };
    }

    // Try streaming mode first
    if (agent.runStream) {
      const stream = agent.runStream(ctx, { messages, goal: routedGoal });
      let finalResult: AgentResult | undefined;

      for await (const event of stream) {
        switch (event.type) {
          case 'step_start':
          case 'step_end':
            if (event.step) {
              res.write(`data: ${JSON.stringify({
                type: 'step',
                step: {
                  index: event.step.index,
                  type: event.step.type,
                  content: event.step.content,
                  toolCall: event.step.toolCall,
                  delegation: event.step.delegation,
                  durationMs: event.step.durationMs,
                },
                phase: event.type,
              })}\n\n`);
            }
            break;
          case 'text_chunk':
            if (event.text) {
              res.write(`data: ${JSON.stringify({ type: 'text', text: event.text })}\n\n`);
            }
            break;
          case 'tool_start':
            if (event.step?.toolCall) {
              res.write(`data: ${JSON.stringify({
                type: 'tool_start',
                name: event.step.toolCall.name,
                arguments: event.step.toolCall.arguments,
              })}\n\n`);
            }
            break;
          case 'tool_end':
            if (event.step?.toolCall) {
              res.write(`data: ${JSON.stringify({
                type: 'tool_end',
                name: event.step.toolCall.name,
                result: event.step.toolCall.result,
                durationMs: event.step.durationMs,
              })}\n\n`);
            }
            break;
          case 'done':
            finalResult = event.result;
            break;
        }
      }

      if (finalResult) return { result: finalResult, toolCallEvents: toolCallObserver.events };
    }

    // Fallback: non-streaming agent run, send result as single text event
    const result = await agent.run(ctx, { messages, goal: routedGoal });
    res.write(`data: ${JSON.stringify({ type: 'text', text: result.output })}\n\n`);

    // Send step summaries
    for (const step of result.steps) {
      res.write(`data: ${JSON.stringify({
        type: 'step',
        step: { index: step.index, type: step.type, content: step.content, toolCall: step.toolCall, delegation: step.delegation, durationMs: step.durationMs },
        phase: 'step_end',
      })}\n\n`);
    }

    return { result, toolCallEvents: toolCallObserver.events };
    } finally {
      screenshotUnsub?.();
      toolCallObserver.dispose();
    }
  }

  // ── Redaction ───────────────────────────────────────────────

  private async applyRedaction(
    ctx: ExecutionContext,
    text: string,
    patterns: string[],
  ): Promise<{ redacted: string; wasModified: boolean; detections: Array<{ type: string; start: number; end: number }> }> {
    try {
      const redactor = weaveRedactor({
        patterns: patterns.map((p) => ({ name: p, type: 'builtin' as const, builtinType: p })),
        reversible: true,
      });
      const result = await redactor.redact(ctx, text);
      return {
        redacted: result.redacted,
        wasModified: result.wasModified,
        detections: result.detections.map((d) => ({ type: d.type, start: d.start, end: d.end })),
      };
    } catch {
      return { redacted: text, wasModified: false, detections: [] };
    }
  }

  // ── Post-eval ───────────────────────────────────────────────

  private async runPostEval(
    ctx: ExecutionContext,
    userId: string,
    chatId: string,
    input: string,
    output: string,
    latencyMs: number,
    cost: number,
    guardrailDecision?: 'allow' | 'warn' | 'deny',
  ): Promise<{ passed: number; failed: number; total: number; score: number } | undefined> {
    try {
      const runner = weaveEvalRunner({
        executor: async (_ctx, inp) => ({
          output: inp['output'] as string,
          guardrailDecision: inp['guardrailDecision'] as string,
        }),
      });

      const result = await runner.run(ctx, {
        name: 'chat_response_quality',
        description: 'Quick quality check on chat response',
        type: 'model',
        assertions: [
          { name: 'not_empty', type: 'regex', config: { pattern: '.+' } },
          { name: 'latency_ok', type: 'latency_threshold', config: { maxMs: 30_000 } },
          { name: 'cost_ok', type: 'cost_threshold', config: { maxCostUsd: 1.0 } },
          { name: 'safety', type: 'safety', config: { blockedPhrases: [] } },
          { name: 'guardrail_ok', type: 'guardrail_decision', config: { warnPenalty: 0.25, denyPenalty: 1.0 } },
        ],
      }, [
        { id: 'msg', input: { output, latencyMs, costUsd: cost, guardrailDecision: guardrailDecision ?? 'allow' }, expected: {} },
      ]);

      const info = {
        passed: result.passed,
        failed: result.failed,
        total: result.totalCases * result.results[0]!.assertions.length,
        score: result.avgScore ?? (result.passed / (result.passed + result.failed || 1)),
      };

      // Persist
      await this.db.recordEval({
        id: randomUUID(), userId, chatId,
        evalName: 'chat_response_quality',
        score: info.score, passed: info.passed, failed: info.failed, total: info.total,
        details: JSON.stringify(result.results[0]?.assertions),
      });

      return info;
    } catch {
      return undefined;
    }
  }

  // ── Trace persistence ───────────────────────────────────────

  private observeToolCallEvents(eventBus: EventBus): { events: ToolCallObservableEvent[]; dispose: () => void } {
    const events: ToolCallObservableEvent[] = [];
    const unsubscribers: Array<() => void> = [];

    unsubscribers.push(eventBus.on(EventTypes.ToolCallStart, (event) => {
      events.push({
        phase: 'start',
        timestamp: event.timestamp,
        executionId: event.executionId,
        spanId: event.spanId,
        data: event.data,
      });
    }));

    unsubscribers.push(eventBus.on(EventTypes.ToolCallEnd, (event) => {
      events.push({
        phase: 'end',
        timestamp: event.timestamp,
        executionId: event.executionId,
        spanId: event.spanId,
        data: event.data,
      });
    }));

    unsubscribers.push(eventBus.on(EventTypes.ToolCallError, (event) => {
      events.push({
        phase: 'error',
        timestamp: event.timestamp,
        executionId: event.executionId,
        spanId: event.spanId,
        data: event.data,
      });
    }));

    return {
      events,
      dispose: () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      },
    };
  }

  private async recordTraceSpans(
    userId: string,
    chatId: string,
    messageId: string,
    traceId: string,
    mode: string,
    startMs: number,
    latencyMs: number,
    steps?: AgentStep[],
    toolCallEvents?: ToolCallObservableEvent[],
    capabilities?: CapabilityTelemetrySummary[],
  ): Promise<void> {
    try {
      // Root span
      const rootSpanId = randomUUID();
      await this.db.saveTrace({
        id: randomUUID(), userId, chatId, messageId,
        traceId, spanId: rootSpanId,
        name: `chat.${mode}`,
        startTime: startMs, endTime: startMs + latencyMs,
        status: 'ok',
        attributes: JSON.stringify({
          mode,
          capabilityCount: capabilities?.length ?? 0,
          capabilities: capabilities?.map((entry) => ({ kind: entry.kind, key: entry.key, name: entry.name })),
        }),
      });

      // Child spans for agent steps
      if (steps) {
        let offset = startMs;
        for (const step of steps) {
          await this.db.saveTrace({
            id: randomUUID(), userId, chatId, messageId,
            traceId, spanId: randomUUID(), parentSpanId: rootSpanId,
            name: `step.${step.type}${step.toolCall ? `.${step.toolCall.name}` : ''}`,
            startTime: offset, endTime: offset + step.durationMs,
            status: 'ok',
            attributes: JSON.stringify({
              stepIndex: step.index,
              type: step.type,
              toolCall: step.toolCall,
              delegation: step.delegation,
              tokenUsage: step.tokenUsage,
            }),
          });
          offset += step.durationMs;
        }
      }

      if (toolCallEvents?.length) {
        const starts = new Map<string, ToolCallObservableEvent[]>();
        const pending: ToolCallObservableEvent[] = [];

        const keyFor = (event: ToolCallObservableEvent, toolName: string): string =>
          `${event.executionId ?? ''}|${event.spanId ?? ''}|${toolName}`;

        const toolNameFor = (event: ToolCallObservableEvent): string => {
          const fromData = event.data['tool'];
          if (typeof fromData === 'string' && fromData.trim()) return fromData;
          const fromName = event.data['name'];
          if (typeof fromName === 'string' && fromName.trim()) return fromName;
          return 'unknown';
        };

        for (const event of toolCallEvents) {
          const toolName = toolNameFor(event);
          const key = keyFor(event, toolName);
          if (event.phase === 'start') {
            const arr = starts.get(key) ?? [];
            arr.push(event);
            starts.set(key, arr);
            continue;
          }

          const arr = starts.get(key);
          const start = arr?.shift();
          if (arr && arr.length === 0) starts.delete(key);

          const spanStart = start?.timestamp ?? event.timestamp;
          const spanEnd = Math.max(event.timestamp, spanStart + 1);
          pending.push({
            ...event,
            timestamp: spanEnd,
            data: {
              ...event.data,
              _toolName: toolName,
              _startTime: spanStart,
            },
          });
        }

        for (const event of pending) {
          const toolName = (typeof event.data['_toolName'] === 'string' && event.data['_toolName']) ? event.data['_toolName'] as string : 'unknown';
          const spanStart = typeof event.data['_startTime'] === 'number' ? event.data['_startTime'] as number : event.timestamp;
          const status = event.phase === 'error' ? 'error' : 'ok';
          const attributes = { ...event.data };
          delete (attributes as Record<string, unknown>)['_toolName'];
          delete (attributes as Record<string, unknown>)['_startTime'];

          await this.db.saveTrace({
            id: randomUUID(), userId, chatId, messageId,
            traceId,
            spanId: event.spanId ?? randomUUID(),
            parentSpanId: rootSpanId,
            name: `tool_call.${toolName}`,
            startTime: spanStart,
            endTime: event.timestamp,
            status,
            attributes: JSON.stringify({
              phase: event.phase,
              executionId: event.executionId,
              tool: toolName,
              data: attributes,
            }),
          });
        }
      }

      if (capabilities?.length) {
        for (const capability of capabilities) {
          const attributes = capabilityTelemetryToSpanAttributes(capability);
          const event = capabilityTelemetryToEvent(capability, 'success');
          await this.db.saveTrace({
            id: randomUUID(), userId, chatId, messageId,
            traceId,
            spanId: randomUUID(),
            parentSpanId: rootSpanId,
            name: `capability.${capability.kind}.${capability.key}`,
            startTime: startMs,
            endTime: startMs + Math.max(1, capability.durationMs ?? latencyMs),
            status: 'ok',
            attributes: JSON.stringify(attributes),
            events: JSON.stringify([event]),
          });
        }
      }
    } catch {
      // Trace recording is best-effort
    }
  }

  /** Available models based on configured providers + DB pricing table */
  async getAvailableModels(): Promise<Array<{ id: string; provider: string }>> {
    const seen = new Set<string>();
    const models: Array<{ id: string; provider: string }> = [];
    const configuredProviders = new Set(Object.keys(this.config.providers));

    // First, pull enabled models from the DB pricing table
    try {
      const rows = await this.db.listModelPricing();
      for (const row of rows) {
        if (row.enabled && configuredProviders.has(row.provider)) {
          const key = `${row.provider}:${row.model_id}`;
          if (!seen.has(key)) {
            seen.add(key);
            models.push({ id: row.model_id, provider: row.provider });
          }
        }
      }
    } catch {
      // DB lookup is best-effort; fall through to hardcoded fallback
    }

    // Merge hardcoded fallback models (for providers with no DB rows yet)
    const FALLBACK_MODELS: Record<string, string[]> = {
      anthropic: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-4-20250414'],
      openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3', 'o4-mini'],
    };
    for (const provider of configuredProviders) {
      const fallback = FALLBACK_MODELS[provider];
      if (fallback) {
        for (const id of fallback) {
          const key = `${provider}:${id}`;
          if (!seen.has(key)) {
            seen.add(key);
            models.push({ id, provider });
          }
        }
      }
    }
    return models;
  }

  // ── Guardrail evaluation ────────────────────────────────────

  private async evaluateGuardrails(
    chatId: string,
    messageId: string | null,
    input: string,
    stage: GuardrailStage,
    refs?: { userInput?: string; assistantOutput?: string; toolEvidence?: string },
  ): Promise<{ decision: 'allow' | 'deny' | 'warn'; reason?: string; results: GuardrailResult[]; cognitive?: CognitiveCheckSummary }> {
    try {
      const rows = await this.db.listGuardrails();
      const enabledRows = rows.filter(r => r.enabled && stageMatches(r.stage, stage));
      const guardrails: Guardrail[] = enabledRows.map(r => normalizeGuardrail(r, stage));

      const pipeline = createGuardrailPipeline(guardrails, { shortCircuitOnDeny: true });
      const results = guardrails.length > 0
        ? await pipeline.evaluate(input, stage, {
            userInput: refs?.userInput ?? input,
            assistantOutput: refs?.assistantOutput,
            toolEvidence: refs?.toolEvidence,
            action: refs?.userInput ?? input,
          })
        : [];
      const cognitive = summarizeGuardrailResults(results, 'cognitive') ?? undefined;

      const decision = hasDeny(results) ? 'deny' as const : hasWarning(results) ? 'warn' as const : 'allow' as const;
      const reason = getDenyReason(results);

      // Persist evaluation
      await this.db.createGuardrailEval({
        id: randomUUID(),
        chat_id: chatId,
        message_id: messageId,
        stage,
        input_preview: input.slice(0, 100),
        results: JSON.stringify(results),
        overall_decision: decision,
      });

      return { decision, reason, results, cognitive };
    } catch {
      return { decision: 'allow', results: [] };
    }
  }

  // ── Human-task policy evaluation ────────────────────────────

  private async evaluateTaskPolicies(
    steps: AgentStep[],
  ): Promise<Array<{ tool: string; policy: string; taskType: string; priority: string }>> {
    try {
      const rows = await this.db.listHumanTaskPolicies();
      const enabledRows = rows.filter(r => r.enabled);
      if (enabledRows.length === 0) return [];

      const evaluator = new PolicyEvaluator();
      for (const row of enabledRows) {
        evaluator.addPolicy(createPolicy({
          name: row.name,
          description: row.description ?? undefined,
          trigger: row.trigger,
          taskType: row.task_type as any,
          defaultPriority: row.default_priority as any,
          slaHours: row.sla_hours ?? undefined,
          autoEscalateAfterHours: row.auto_escalate_after_hours ?? undefined,
          assignmentStrategy: row.assignment_strategy as any,
          assignTo: row.assign_to ?? undefined,
          enabled: true,
        }));
      }

      const checks: Array<{ tool: string; policy: string; taskType: string; priority: string }> = [];
      for (const step of steps) {
        if (step.toolCall) {
          const result = evaluator.check({ trigger: step.toolCall.name });
          if (result.required && result.policy) {
            checks.push({
              tool: step.toolCall.name,
              policy: result.policy.name,
              taskType: result.policy.taskType,
              priority: result.policy.defaultPriority,
            });
          }
        }
      }

      return checks;
    } catch {
      return [];
    }
  }

  // ── Prompt resolution from DB ───────────────────────────────

  /**
   * Resolve system prompt: if the settings reference a prompt by name/id,
   * look it up in the prompts table and render its template. Falls back to
   * the plain system_prompt string.
   */
  private async resolveSystemPrompt(settings: ChatSettings): Promise<ResolvedSystemPrompt> {
    if (!settings.systemPrompt) return { content: undefined };

    try {
      // Check if the system prompt references a DB prompt by name
      const rows = await this.db.listPrompts();
      const match = rows.find(
        r => r.enabled && (r.id === settings.systemPrompt || r.name === settings.systemPrompt),
      );
      if (match) {
        const versions = await this.db.listPromptVersions(match.id);
        const experiments = await this.db.listPromptExperiments(match.id);
        const resolved = resolvePromptRecordForExecution({
          prompt: match,
          versions,
          experiments,
          options: {
            assignmentKey: match.id,
          },
        });

        const vars: Record<string, unknown> = {};
        const promptVersion = createPromptVersionFromRecord(resolved.record);
        if ('variables' in promptVersion) {
          for (const variable of promptVersion.variables) {
            vars[variable.name] = variable.defaultValue ?? `[${variable.name}]`;
          }
        }

        // Build a fragment registry from enabled DB fragments, then pre-expand
        // {{>key}} inclusions in the template before passing to renderPromptRecord.
        // This lets prompt authors compose templates from reusable fragment blocks
        // without requiring any change to the base rendering pipeline.
        let resolvedMatch = resolved.record;
        try {
          const fragmentRows = await this.db.listPromptFragments();
          const enabledFragments = fragmentRows.filter(f => f.enabled);
          if (enabledFragments.length > 0) {
            const fragmentRegistry = new InMemoryFragmentRegistry();
            for (const row of enabledFragments) {
              fragmentRegistry.register(fragmentFromRecord(row));
            }
            const baseTemplate = resolved.record.template ?? '';
            const expandedTemplate = resolveFragments(baseTemplate, fragmentRegistry);
            if (expandedTemplate !== baseTemplate) {
              // Create a shallow copy with the expanded template for rendering
              resolvedMatch = { ...resolved.record, template: expandedTemplate };
            }
          }
        } catch {
          // Fragment expansion failure is non-fatal — fall through to raw template
        }

        // Build strategy registry from built-in shared strategies plus enabled
        // DB-defined overlays so behavior stays package-driven and DB-configurable.
        const strategyRegistry = new InMemoryPromptStrategyRegistry(defaultPromptStrategyRegistry.list());
        try {
          const strategyRows = await this.db.listPromptStrategies();
          for (const row of strategyRows) {
            if (!row.enabled) continue;
            strategyRegistry.register(strategyFromRecord(row));
          }
        } catch {
          // Strategy loading failure is non-fatal — fallback to built-ins only.
        }

        let promptTelemetry: CapabilityTelemetrySummary | undefined;
        const executed = executePromptRecord(resolvedMatch, vars, {
          strategyRegistry,
          evaluations: [
            {
              id: 'prompt_not_empty',
              description: 'Rendered system prompt should not be empty to avoid unbounded model behavior.',
              evaluate: ({ content }) => ({
                passed: content.trim().length > 0,
                score: content.trim().length > 0 ? 1 : 0,
                reason: content.trim().length > 0 ? undefined : 'Rendered prompt content is empty',
              }),
            },
          ],
          hooks: {
            onTelemetry: ({ telemetry }) => {
              promptTelemetry = telemetry;
            },
          },
        });

        const telemetry = promptTelemetry ?? createPromptCapabilityTelemetry(executed);

        return {
          content: executed.content,
          telemetry: {
            ...telemetry,
            source: 'db',
            selectedBy: resolved.meta.selectedBy,
            metadata: {
              ...(telemetry.metadata ?? {}),
              resolution: resolved.meta,
              expandedFromFragments: resolvedMatch.template !== resolved.record.template,
            },
          },
          strategy: this.toPromptStrategyInfo(executed),
          resolution: resolved.meta,
        };
      }
    } catch {
      // Fall through to plain text
    }

    return { content: settings.systemPrompt };
  }

  private buildCapabilityTelemetrySnapshots(
    mode: string,
    promptTelemetry: CapabilityTelemetrySummary | undefined,
    activeSkills: Array<{ id: string; name: string; description: string; category: string; score: number; tools: string[] }>,
    enabledTools: string[],
  ): CapabilityTelemetrySummary[] {
    const snapshots: CapabilityTelemetrySummary[] = [];

    snapshots.push({
      kind: 'agent',
      key: `geneweave.${mode}`,
      name: mode === 'supervisor' ? 'GeneWeave Supervisor Agent' : mode === 'agent' ? 'GeneWeave Tool Agent' : 'GeneWeave Direct Runtime',
      description: mode === 'supervisor'
        ? 'Coordinates worker delegation, verification, and response synthesis using database-driven prompt, skill, and policy configuration.'
        : mode === 'agent'
        ? 'Runs a tool-calling agent loop with database-driven prompt, skill, and policy overlays.'
        : 'Runs direct model inference with shared prompt, guardrail, and observability integrations.',
      source: 'runtime',
      metadata: {
        mode,
        enabledToolCount: enabledTools.length,
        enabledTools,
      },
    });

    if (promptTelemetry) snapshots.push(promptTelemetry);

    for (const skill of activeSkills) {
      snapshots.push({
        kind: 'skill',
        key: skill.id,
        name: skill.name,
        description: skill.description,
        source: 'db',
        tags: [skill.category],
        metadata: {
          score: skill.score,
          tools: skill.tools,
        },
      });
    }

    return snapshots;
  }

  private toPromptStrategyInfo(result: PromptRecordExecutionResult): PromptStrategyInfo {
    return {
      requestedKey: result.strategy.requestedKey,
      resolvedKey: result.strategy.resolvedKey,
      usedFallback: result.strategy.usedFallback,
      name: result.strategy.name,
      description: result.strategy.description,
      metadata: result.strategy.metadata,
    };
  }

  // ── Model routing from DB ───────────────────────────────────

  /**
   * Select model + provider using the active routing policy from the DB.
   * Returns null if no enabled policy exists (caller falls back to default).
   */
  private async routeModel(opts?: { provider?: string; model?: string }): Promise<{ provider: string; modelId: string } | null> {
    try {
      const policies = await this.db.listRoutingPolicies();
      const active = policies.find(p => p.enabled);
      if (!active) return null;

      // Build candidate list from configured providers
      const candidates = (await this.getAvailableModels()).map(m => ({
        modelId: m.id,
        providerId: m.provider,
      }));

      if (candidates.length === 0) return null;

      // Load pricing & quality from DB (falls back to hardcoded if DB is empty)
      const pricingRows = await this.db.listModelPricing();
      const pricingMap = new Map(pricingRows.filter(r => r.enabled).map(r => [`${r.provider}:${r.model_id}`, r]));

      // Cost data from DB model_pricing table
      const costs: ModelCostInfo[] = candidates.map(c => {
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
      const qualities: ModelQualityInfo[] = candidates.map(c => {
        const row = pricingMap.get(`${c.providerId}:${c.modelId}`);
        return {
          modelId: c.modelId,
          providerId: c.providerId,
          qualityScore: row ? row.quality_score : 0.7,
        };
      });

      const router = new SmartModelRouter({ candidates, costs, qualities });

      // Copy health data
      for (const h of this.healthTracker.listHealth()) {
        router.recordOutcome(
          { modelId: h.modelId, providerId: h.providerId, reason: '', scores: {}, alternatives: [], timestamp: '' },
          { latencyMs: h.avgLatencyMs, success: h.errorRate < 0.5 },
        );
      }

      const decision = await router.route(
        { prompt: '' },
        {
          id: active.id,
          name: active.name,
          strategy: active.strategy as any,
          constraints: active.constraints ? JSON.parse(active.constraints) : undefined,
          weights: active.weights ? JSON.parse(active.weights) : undefined,
          fallbackModelId: active.fallback_model ?? undefined,
          fallbackProviderId: active.fallback_provider ?? undefined,
          enabled: true,
        },
      );

      return { provider: decision.providerId, modelId: decision.modelId };
    } catch {
      return null;
    }
  }

  // ── Memory helpers ─────────────────────────────────────────────────────────

  private async loadExtractionRules(): Promise<MemoryExtractionRule[]> {
    const rows = await this.db.listMemoryExtractionRules();
    return rows.map((r) => {
      let factsTemplate: Record<string, unknown> | null = null;
      try {
        factsTemplate = r.facts_template ? JSON.parse(r.facts_template) as Record<string, unknown> : null;
      } catch {
        factsTemplate = null;
      }
      return {
        id: r.id,
        ruleType: r.rule_type as MemoryExtractionRule['ruleType'],
        entityType: r.entity_type,
        pattern: r.pattern,
        flags: r.flags,
        factsTemplate,
        priority: r.priority,
        enabled: !!r.enabled,
      };
    });
  }

  private safeParseJson(text: string): unknown {
    const trimmed = text.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const raw = fenced?.[1] ?? trimmed;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private sanitizeExtractedEntities(raw: unknown): Array<{ name: string; type: string; facts: Record<string, unknown> }> {
    if (!Array.isArray(raw)) return [];
    const allowedTypes = new Set(['person', 'location', 'organization', 'preference', 'topic', 'general']);
    const out: Array<{ name: string; type: string; facts: Record<string, unknown> }> = [];
    for (const item of raw.slice(0, 8)) {
      if (!item || typeof item !== 'object') continue;
      const row = item as { name?: unknown; type?: unknown; facts?: unknown };
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      if (!name || name.length > 120) continue;
      const typeRaw = typeof row.type === 'string' ? row.type.toLowerCase().trim() : 'general';
      const type = allowedTypes.has(typeRaw) ? typeRaw : 'general';
      const facts = (row.facts && typeof row.facts === 'object' && !Array.isArray(row.facts))
        ? (row.facts as Record<string, unknown>)
        : {};
      out.push({ name, type, facts });
    }
    return out;
  }

  private async extractEntitiesWithModel(
    ctx: ExecutionContext,
    model: Model,
    userContent: string,
    assistantContent: string,
  ): Promise<ExtractedEntity[]> {
    const request: ModelRequest = {
      messages: [
        {
          role: 'system',
          content: [
            'You extract durable user profile entities from a conversation turn.',
            'Think carefully about stable facts, but output JSON only.',
            'Return a JSON array, each item as: {"name": string, "type": "person|location|organization|preference|topic|general", "facts": object}.',
            'Only include entities that are explicitly stated or strongly implied by the user.',
            'Do not include temporary tasks or speculative details.',
            'If nothing durable is present, return [].',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `User message: ${userContent}`,
            `Assistant response: ${assistantContent.slice(0, 600)}`,
            'Return JSON array only.',
          ].join('\n\n'),
        },
      ],
      maxTokens: 500,
      temperature: 0,
    };
    const res = await model.generate(ctx, request);
    const parsed = this.safeParseJson(res.content);
    return this.sanitizeExtractedEntities(parsed).map((e) => ({
      ...e,
      confidence: 0.78,
      source: 'llm' as const,
    }));
  }

  private async classifyIdentityRecallIntent(ctx: ExecutionContext, model: Model, query: string): Promise<boolean> {
    const regexSignal = /\b(name|who\s+am\s+i|who\s+i\s+am|what\s+am\s+i\s+called|what'?s\s+my\s+name|remember\s+my\s+name|do\s+you\s+know\s+who\s+i\s+am)\b/i.test(query);
    if (regexSignal) return true;

    // Avoid model classification for long prompts where identity intent is unlikely.
    if (query.length > 180) return false;

    try {
      const request: ModelRequest = {
        messages: [
          {
            role: 'system',
            content: [
              'Classify whether the user is asking the assistant to recall who the user is based on prior memory.',
              'Return ONLY one token: YES or NO.',
              'Use YES for questions about identity, name, personal profile, or remembered user details from prior chats.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: query,
          },
        ],
        maxTokens: 3,
        temperature: 0,
      };
      const res = await model.generate(ctx, request);
      return /^\s*yes\b/i.test(res.content);
    } catch {
      return false;
    }
  }

  private isIdentityRecallQuery(query: string): boolean {
    return /\b(do\s+you\s+know\s+who\s+i\s+am|who\s+am\s+i|who\s+i\s+am|do\s+you\s+remember\s+me|do\s+you\s+know\s+my\s+name|what(?:'|\s+)?s\s+my\s+name|remember\s+my\s+name)\b/i.test(query);
  }

  private async resolveIdentityRecallFromMemory(userId: string, query: string): Promise<string | null> {
    if (!this.isIdentityRecallQuery(query)) return null;

    const [entities, semanticRows] = await Promise.all([
      this.db.listEntities(userId),
      this.db.listSemanticMemory(userId, 24),
    ]);

    let name: string | null = null;
    let location: string | null = null;

    const personEntity = entities.find((e) => e.entity_type.toLowerCase() === 'person');
    if (personEntity?.entity_name) {
      name = personEntity.entity_name.trim();
    }
    const locationEntity = entities.find((e) => e.entity_type.toLowerCase() === 'location');
    if (locationEntity?.entity_name) {
      location = locationEntity.entity_name.trim();
    }

    const semanticPriority = semanticRows
      .filter((m) => m.memory_type === 'user_fact' || m.source === 'user')
      .concat(semanticRows.filter((m) => !(m.memory_type === 'user_fact' || m.source === 'user')));

    for (const m of semanticPriority) {
      if (!name) {
        const nm = m.content.match(/\b(?:my\s+name\s+is|i\s+am|i'?m\s+called|call\s+me)\s+([A-Za-z][A-Za-z\-']{1,39})\b/i);
        if (nm?.[1]) name = nm[1].trim();
      }
      if (!location) {
        const lm = m.content.match(/\b(?:i\s+live\s+in|i'?m\s+from|i\s+am\s+from|i\s+reside\s+in)\s+([A-Za-z][A-Za-z\s\-']{1,50}?)(?=\s+(?:and|but)\b|[,.!?]|$)/i);
        if (lm?.[1]) location = lm[1].trim();
      }
      if (name && location) break;
    }

    if (name && location) {
      return `From our previous chats, you are ${name} and you live in ${location}.`;
    }
    if (name) {
      return `From our previous chats, you are ${name}.`;
    }
    if (location) {
      return `From our previous chats, I remember that you live in ${location}.`;
    }
    return null;
  }

  private async buildMemoryContext(ctx: ExecutionContext, model: Model, userId: string, query: string): Promise<string | null> {
    try {
      const identityQuery = await this.classifyIdentityRecallIntent(ctx, model, query);
      const entityPromise = identityQuery
        ? this.db.listEntities(userId).then((rows) => rows.slice(0, 10))
        : this.db.searchEntities(userId, query);
      const [semanticMatches, entityMatches, recentSemantic] = await Promise.all([
        this.db.searchSemanticMemory({ userId, query, limit: 5 }),
        entityPromise,
        identityQuery ? this.db.listSemanticMemory(userId, 12) : Promise.resolve([]),
      ]);

      const semanticForContext = semanticMatches.length > 0
        ? semanticMatches
        : (identityQuery
          ? recentSemantic.filter((m) => m.memory_type === 'user_fact' || m.source === 'user').slice(0, 5)
          : []);

      if (semanticForContext.length === 0 && entityMatches.length === 0) return null;
      const parts: string[] = ['[Long-term memory from past conversations]'];

      let inferredIdentityName: string | null = null;
      if (identityQuery) {
        const person = entityMatches.find((e) => e.entity_type.toLowerCase() === 'person');
        if (person?.entity_name) {
          inferredIdentityName = person.entity_name;
        } else {
          for (const m of semanticForContext) {
            const nameMatch = m.content.match(/\bmy\s+name\s+is\s+([A-Za-z][A-Za-z\-']{1,39})\b/i);
            if (nameMatch?.[1]) {
              inferredIdentityName = nameMatch[1];
              break;
            }
          }
        }
      }

      if (identityQuery) {
        parts.push('Identity recall request detected. Use these memories to identify the user when possible.');
        parts.push('If a name or identity fact is present below, answer directly from memory and do not claim you lack memory.');
        if (inferredIdentityName) {
          parts.push(`Most likely user name from memory: "${inferredIdentityName}".`);
        }
      }
      if (entityMatches.length > 0) {
        parts.push('Known facts about this user:');
        for (const e of entityMatches) {
          const factsObj = JSON.parse(e.facts) as Record<string, unknown>;
          const factsStr = Object.entries(factsObj)
            .filter(([k]) => !k.startsWith('noted_'))
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
          parts.push(`  • ${e.entity_type} "${e.entity_name}"${factsStr ? ' — ' + factsStr : ''}`);
        }
      }
      if (semanticForContext.length > 0) {
        parts.push('Relevant memories:');
        for (const m of semanticForContext) {
          const label = m.source === 'user' ? 'User stated' : 'Previously discussed';
          parts.push(`  • [${label}] ${m.content.slice(0, 200)}`);
        }
      }
      return parts.join('\n');
    } catch {
      return null;
    }
  }

  private async saveToMemory(
    ctx: ExecutionContext,
    model: Model,
    userId: string,
    chatId: string,
    userContent: string,
    assistantContent: string,
  ): Promise<void> {
    const rules = await this.loadExtractionRules();
    const extraction = await runHybridMemoryExtraction({
      ctx,
      input: { userContent, assistantContent },
      rules,
      llmExtractor: async (innerCtx, input) => this.extractEntitiesWithModel(innerCtx, model, input.userContent, input.assistantContent ?? ''),
    });

    if (extraction.selfDisclosure && userContent.length > 5) {
      await this.db.saveSemanticMemory({
        id: randomUUID(),
        userId,
        chatId,
        content: userContent.slice(0, 600),
        memoryType: 'user_fact',
        source: 'user',
      });
    }
    if (assistantContent.length > 100) {
      await this.db.saveSemanticMemory({
        id: randomUUID(),
        userId,
        chatId,
        content: assistantContent.slice(0, 600),
        memoryType: 'summary',
        source: 'assistant',
      });
    }

    for (const e of extraction.entities) {
      await this.db.upsertEntity({
        userId,
        entityName: e.name,
        entityType: e.type,
        facts: e.facts,
        confidence: e.confidence,
        source: e.source,
        chatId,
      });
    }

    const regexEntitiesCount = extraction.entities.filter((e) => e.source === 'regex').length;
    const llmEntitiesCount = extraction.entities.filter((e) => e.source === 'llm').length;
    await this.db.recordMemoryExtractionEvent({
      id: randomUUID(),
      userId,
      chatId,
      selfDisclosure: extraction.selfDisclosure,
      regexEntitiesCount,
      llmEntitiesCount,
      mergedEntitiesCount: extraction.entities.length,
      events: JSON.stringify(extraction.events),
    });
  }

  /**
   * Resolve the best-matching cache policy from admin-configured policies.
   */
  private async resolveActiveCache(mode: string): Promise<CachePolicy | null> {
    try {
      const rows = await this.db.listCachePolicies();
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

  /**
   * Record model outcome for health tracking.
   */
  recordModelOutcome(modelId: string, providerId: string, latencyMs: number, success: boolean): void {
    this.healthTracker.record(modelId, providerId, { latencyMs, success });
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function historyToMessages(rows: MessageRow[]): Message[] {
  return rows.map((r) => ({
    role: r.role as Message['role'],
    content: r.content,
  }));
}
