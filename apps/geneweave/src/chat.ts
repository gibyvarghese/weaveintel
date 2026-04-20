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
} from '@weaveintel/core';
import { weaveContext, weaveEventBus, EventTypes } from '@weaveintel/core';
import { weaveAgent, weaveSupervisor } from '@weaveintel/agents';
import {
  weaveInMemoryTracer,
  weaveUsageTracker,
} from '@weaveintel/observability';
import type { GuardrailCategorySummary } from '@weaveintel/guardrails';
import type { DatabaseAdapter, MessageRow, ChatSettingsRow, GuardrailRow, HumanTaskPolicyRow, PromptRow, RoutingPolicyRow } from './db.js';
import { BUILTIN_TOOLS, createToolRegistry, type ToolRegistryOptions } from './tools.js';
import { createTemporalStore } from './temporal-store.js';
import {
  applySkillsToPrompt,
  type SkillMatch,
} from '@weaveintel/skills';
import { createContract, DefaultCompletionValidator } from '@weaveintel/contracts';
import { ModelHealthTracker } from '@weaveintel/routing';
import { weaveInMemoryCacheStore } from '@weaveintel/cache';
import { weaveCacheKeyBuilder } from '@weaveintel/cache';
import { shouldBypass } from '@weaveintel/cache';
import { loadEnterpriseTools, loadEnterpriseToolGroups, type EnterpriseToolGroup } from './chat-enterprise-tools-utils.js';
import {
  loadExtractionRules,
  extractEntitiesWithModel,
  classifyIdentityRecallIntent,
  isIdentityRecallQuery,
  resolveIdentityRecallFromMemory,
  buildMemoryContext,
  saveToMemory,
} from './chat-memory-utils.js';
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
import {
  loadModelPricing,
  type ModelPricing,
  type PricingCache,
} from './chat-pricing-utils.js';
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
import {
  loadPolicyPromptTemplates,
  renderNamedPolicyPromptTemplate,
  type PolicyPromptCache,
} from './chat-policy-prompt-utils.js';
import {
  validatePromptContractsAgainstDb,
  type PromptContractValidationReport,
} from './chat-prompt-contract-utils.js';
import { buildSupervisorInstructionsPrompt } from './chat-supervisor-policy-utils.js';
import { applyTemporalToolPolicy } from './chat-policy-format-utils.js';
import { shouldForceWorkerDataAnalysis } from './chat-intent-utils.js';
import { discoverSkillsForInput } from './chat-skills-utils.js';
import { applyRedaction, runPostEval } from './chat-eval-utils.js';
import { observeToolCallEvents, recordTraceSpans, type ToolCallObservableEvent, type AgentRunTelemetry } from './chat-trace-utils.js';
import { evaluateGuardrails, evaluateTaskPolicies } from './chat-guardrail-eval-utils.js';
import {
  resolveSystemPrompt,
  buildCapabilityTelemetrySnapshots,
  type PromptStrategyInfo,
  type ResolvedSystemPrompt,
} from './chat-system-prompt-utils.js';
import { routeModel, resolveActiveCache } from './chat-routing-utils.js';

export { calculateCost, getOrCreateModel, settingsFromRow } from './chat-runtime.js';
export type { ChatAttachment, ProviderConfig, ChatEngineConfig, ChatSettings, WorkerDef } from './chat-runtime.js';

// ─── Chat engine ─────────────────────────────────────────────

type CognitiveCheckSummary = GuardrailCategorySummary;

export class ChatEngine {
  private readonly healthTracker = new ModelHealthTracker();
  private readonly responseCache = weaveInMemoryCacheStore();
  private readonly cacheKeyBuilder = weaveCacheKeyBuilder({ namespace: 'gw-chat' });
  private pricingCache: PricingCache | null = null;
  private policyPromptCache: PolicyPromptCache | null = null;
  private readonly toolOptions: ToolRegistryOptions;

  private async getPolicyPromptTemplates(): Promise<Map<string, string>> {
    const result = await loadPolicyPromptTemplates(this.db, this.policyPromptCache);
    this.policyPromptCache = result.cache;
    return result.prompts;
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
    return renderNamedPolicyPromptTemplate(name, template, fallbackTemplate, vars);
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

  private async getDisabledBuiltinToolKeys(): Promise<Set<string>> {
    const enabledCatalogRows = await this.db.listEnabledToolCatalog();
    const enabledKeys = new Set(
      enabledCatalogRows
        .map((row) => row.tool_key)
        .filter((toolKey): toolKey is string => Boolean(toolKey)),
    );
    return new Set(Object.keys(BUILTIN_TOOLS).filter((toolKey) => !enabledKeys.has(toolKey)));
  }

  /**
   * Build supervisor worker definitions from DB `worker_agents` rows.
   */
  private buildWorkersFromDb(
    workerRows: import('./db-types.js').WorkerAgentRow[],
    model: Model,
    toolOptions: ToolRegistryOptions,
    customTools?: import('@weaveintel/core').Tool[],
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
    const result = await loadModelPricing(this.db, this.pricingCache);
    this.pricingCache = result.cache;
    return result.pricing;
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
    const routed = await routeModel(this.db, await this.getAvailableModels(), this.healthTracker.listHealth(), opts);
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

    const model = await getOrCreateModel(provider, modelId, providerCfg);
    const actor = await this.db.getUserById(userId);
    const userPersona = normalizePersona(actor?.persona, 'user');
    const settings = settingsFromRow(await this.db.getChatSettings(chatId));
    const resolvedSystemPrompt = await resolveSystemPrompt(this.db, settings);
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
      const rd = await applyRedaction(ctx, contentWithAttachments, settings.redactionPatterns);
      processedContent = rd.redacted;
      if (rd.wasModified) {
        redactionInfo = { count: rd.detections.length, types: [...new Set(rd.detections.map((d: any) => d.type))] };
      }
    }

    // Discover skills from the user request and auto-enable their associated tools.
    const skillContext = await discoverSkillsForInput(this.db, processedContent, model, ctx, settings.mode, (t) => this.safeParseJson(t));
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
    const preGuardrail = await evaluateGuardrails(this.db, chatId, userMsgId, processedContent, 'pre-execution');
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

    const identityRecall = await resolveIdentityRecallFromMemory(this.db, userId, processedContent);
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
    const memoryContext = await buildMemoryContext(this.db, ctx, model, userId, processedContent);
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
    const cachePolicy = allowResponseCache ? await resolveActiveCache(this.db, settings.mode) : null;
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

    contractInfo = await validatePromptContractsAgainstDb(assistantContent, this.db);


    const latencyMs = Date.now() - startMs;
    const dbPricing = await this.loadPricing();
    const cost = calculateCost(modelId, usage.promptTokens, usage.completionTokens, dbPricing.get(modelId));

    // Record health outcome
    this.recordModelOutcome(modelId, provider, latencyMs, true);

    // Human-task policy checks on tool calls
    const policyChecks = steps ? await evaluateTaskPolicies(this.db, steps) : undefined;

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
    const postGuardrail = await evaluateGuardrails(this.db, chatId, null, assistantContent, 'post-execution', {
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
    evalInfo = await runPostEval(this.db, ctx, userId, chatId, processedContent, assistantContent, latencyMs, cost, overallGuardrailDecision);

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
      await saveToMemory(this.db, ctx, model, userId, chatId, processedContent, assistantContent);
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
    await recordTraceSpans(
      this.db,
      userId,
      chatId,
      assistMsgId,
      traceId,
      settings.mode,
      startMs,
      latencyMs,
      steps,
      toolCallEvents,
      buildCapabilityTelemetrySnapshots(
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
    const routed = await routeModel(this.db, await this.getAvailableModels(), this.healthTracker.listHealth(), opts);
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

    const model = await getOrCreateModel(provider, modelId, providerCfg);
    const actor = await this.db.getUserById(userId);
    const userPersona = normalizePersona(actor?.persona, 'user');
    const settings = settingsFromRow(await this.db.getChatSettings(chatId));
    const resolvedSystemPrompt = await resolveSystemPrompt(this.db, settings);
    const resolvedPrompt = await this.withResponseCardFormatPolicy(resolvedSystemPrompt.content);
    const traceId = randomUUID();
    const ctx = weaveContext({ userId, deadline: Date.now() + 120_000, metadata: { traceId, chatId } });

    const attachments = normalizeAttachments(opts?.attachments);
    const contentWithAttachments = composeUserInput(content, attachments);

    // Redaction
    let processedContent = contentWithAttachments;
    let redactionInfo: { count: number; types: string[] } | undefined;
    if (settings.redactionEnabled) {
      const rd = await applyRedaction(ctx, contentWithAttachments, settings.redactionPatterns);
      processedContent = rd.redacted;
      if (rd.wasModified) {
        redactionInfo = { count: rd.detections.length, types: [...new Set(rd.detections.map((d: any) => d.type))] };
      }
    }

    // Discover skills from the user request and auto-enable their associated tools.
    const streamSkillContext = await discoverSkillsForInput(this.db, processedContent, model, ctx, settings.mode, (t) => this.safeParseJson(t));
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
    const preGuardrail = await evaluateGuardrails(this.db, chatId, userMsgId, processedContent, 'pre-execution');
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

    const identityRecall = await resolveIdentityRecallFromMemory(this.db, userId, processedContent);
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
    const streamMemoryContext = await buildMemoryContext(this.db, ctx, model, userId, processedContent);
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
    const policyChecks = steps.length ? await evaluateTaskPolicies(this.db, steps) : undefined;
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
    const postGuardrail = await evaluateGuardrails(this.db, chatId, null, fullText, 'post-execution', {
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
    const evalInfo = await runPostEval(this.db, ctx, userId, chatId, processedContent, fullText, latencyMs, cost, streamGuardrailDecision);
    if (evalInfo) {
      res.write(`data: ${JSON.stringify({ type: 'eval', ...evalInfo })}\n\n`);
    }

    streamContractInfo = await validatePromptContractsAgainstDb(fullText, this.db);
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
      await saveToMemory(this.db, ctx, model, userId, chatId, processedContent, fullText);
    } catch {
      // Keep chat success path resilient when memory persistence fails.
    }

    await this.db.recordMetric({
      id: randomUUID(), userId, chatId, type: 'generation', provider, model: modelId,
      promptTokens: finalUsage.promptTokens, completionTokens: finalUsage.completionTokens,
      totalTokens: finalUsage.totalTokens, cost, latencyMs,
    });

    await recordTraceSpans(this.db, userId, chatId, assistMsgId, traceId, settings.mode, startMs, latencyMs, steps, toolCallEvents);
    await recordTraceSpans(
      this.db,
      userId,
      chatId,
      assistMsgId,
      traceId,
      settings.mode,
      startMs,
      latencyMs,
      steps,
      toolCallEvents,
      buildCapabilityTelemetrySnapshots(
        settings.mode,
        resolvedSystemPrompt.telemetry,
        streamActiveSkills,
        streamMemorySettings.enabledTools,
      ),
    );
    res.end();
  }

  // ── Enterprise tools loader ─────────────────────────────────

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
    const enterpriseToolGroups = await loadEnterpriseToolGroups(this.db);
    const hasEnterprise = enterpriseToolGroups.length > 0;
    const disabledToolKeys = await this.getDisabledBuiltinToolKeys();
    // Flat enterprise tools for backward compat (base tools only, no extended)
    const enterpriseTools = hasEnterprise ? await loadEnterpriseTools(this.db) : [];
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
      disabledToolKeys,
    };
    const customTools = enterpriseTools.length > 0 ? enterpriseTools : undefined;
    const tools = settings.enabledTools.length
      ? createToolRegistry(settings.enabledTools, customTools, toolOptions)
      : customTools?.length ? createToolRegistry([], customTools, toolOptions) : undefined;

    const agentBus = weaveEventBus();
    const toolCallObserver = observeToolCallEvents(agentBus);

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
    const enterpriseToolGroups = await loadEnterpriseToolGroups(this.db);
    const hasEnterprise = enterpriseToolGroups.length > 0;
    const enterpriseTools = hasEnterprise ? await loadEnterpriseTools(this.db) : [];
    const disabledToolKeys = await this.getDisabledBuiltinToolKeys();
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
      disabledToolKeys,
    };
    const customTools = enterpriseTools.length > 0 ? enterpriseTools : undefined;
    const tools = settings.enabledTools.length
      ? createToolRegistry(settings.enabledTools, customTools, toolOptions)
      : customTools?.length ? createToolRegistry([], customTools, toolOptions) : undefined;

    // Create event bus to capture sub-agent events (e.g. screenshots from workers)
    const agentBus = weaveEventBus();
    const toolCallObserver = observeToolCallEvents(agentBus);
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
      mock: ['mock-model'],
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
