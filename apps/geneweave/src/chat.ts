/**
 * @weaveintel/geneweave — Chat engine
 *
 * Orchestrates weaveIntel models for chat. Supports three modes:
 *  - **direct**: model.generate / model.stream (default, original behavior)
 *  - **agent**: weaveAgent with tool-calling ReAct loop
 *  - **supervisor**: weaveAgent in supervisor mode with hierarchical worker delegation
 *
 * Integrates redaction (PII scrubbing), observability (trace spans),
 * and eval (response quality assertions) into the message flow.
 *
 * WeaveIntel packages integrated here:
 *   @weaveintel/core         — ExecutionContext, EventBus, Model/ToolRegistry types
 *   @weaveintel/agents       — weaveAgent (ReAct loop, with optional supervisor mode)
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
import { weaveAgent } from '@weaveintel/agents';
import {
  weaveInMemoryTracer,
  weaveUsageTracker,
} from '@weaveintel/observability';
import type { GuardrailCategorySummary } from '@weaveintel/guardrails';
import type { DatabaseAdapter, MessageRow, ChatSettingsRow, GuardrailRow, HumanTaskPolicyRow, PromptRow, RoutingPolicyRow } from './db.js';
import { BUILTIN_TOOLS, createToolRegistry, type ToolRegistryOptions } from './tools.js';
import { DbToolPolicyResolver, DbToolRateLimiter, consoleAuditEmitter } from './tool-policy-resolver.js';
import { DbToolAuditEmitter } from './tool-audit-emitter.js';
import { DbToolApprovalGate } from './tool-approval-gate.js';
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
  POLICY_PROMPT_MANDATORY_SKILL_PLAN_GUARD,
  FORCED_WORKER_REQUIREMENT,
  HARD_EXECUTION_GUARD_POLICY,
  MANDATORY_SKILL_PLAN_GUARD_POLICY,
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
  countWorkerDelegations,
  hasCodeExecutorDelegation,
  hasMandatoryBusinessDataPlanConformance,
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
import { observeToolCallEvents, recordTraceSpans, computePromptFingerprint, type ToolCallObservableEvent, type AgentRunTelemetry } from './chat-trace-utils.js';
import { evaluateGuardrails, evaluateTaskPolicies } from './chat-guardrail-eval-utils.js';
import {
  resolveSystemPrompt,
  buildCapabilityTelemetrySnapshots,
  type PromptStrategyInfo,
  type ResolvedSystemPrompt,
} from './chat-system-prompt-utils.js';
import { routeModel, resolveActiveCache } from './chat-routing-utils.js';
import {
  sendMessageImpl,
  type SendMessageDeps,
  type SendMessageResult,
} from './chat-send-message.js';
import { streamMessageImpl } from './chat-stream-message.js';

export { calculateCost, getOrCreateModel, settingsFromRow } from './chat-runtime.js';
export type { ChatAttachment, ProviderConfig, ChatEngineConfig, ChatSettings, WorkerDef } from './chat-runtime.js';

// ─── Chat engine ─────────────────────────────────────────────

type CognitiveCheckSummary = GuardrailCategorySummary;

/**
 * Phase 2 — exported for unit tests. Build a ToolRegistry from a resolved
 * supervisor agent's `agent_tools` allocations (skipping `forbidden`).
 * Returns `undefined` when there is nothing to allocate.
 */
export async function buildSupervisorAdditionalTools(
  resolved: import('./db-types.js').ResolvedSupervisorAgent | null,
  toolOptions: ToolRegistryOptions,
): Promise<ToolRegistry | undefined> {
  if (!resolved || !resolved.tools.length) return undefined;
  const toolNames = Array.from(new Set(
    resolved.tools
      .filter((t) => (t.allocation ?? 'default') !== 'forbidden')
      .map((t) => t.tool_name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0),
  ));
  if (!toolNames.length) return undefined;
  try {
    return await createToolRegistry(toolNames, undefined, { ...toolOptions, actorPersona: 'agent_supervisor' });
  } catch (err) {
    console.warn('[chat] buildSupervisorAdditionalTools failed; supervisor will use defaults only', err);
    return undefined;
  }
}

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

  private async writeSseEvent(res: ServerResponse, payload: Record<string, unknown>): Promise<boolean> {
    if (res.writableEnded || res.destroyed) {
      return false;
    }

    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    const canContinue = res.write(frame);
    if (canContinue) {
      return !(res.writableEnded || res.destroyed);
    }

    await new Promise<void>((resolve) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        res.off('drain', onDrain);
        res.off('close', onClose);
      };

      res.on('drain', onDrain);
      res.on('close', onClose);
    });

    return !(res.writableEnded || res.destroyed);
  }

  private endSse(res: ServerResponse): void {
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }

  constructor(
    private readonly config: ChatEngineConfig,
    private readonly db: DatabaseAdapter,
  ) {
    this.toolOptions = {
      temporalStore: createTemporalStore(db),
      policyResolver: new DbToolPolicyResolver(db),
      rateLimiter: new DbToolRateLimiter(db),
      auditEmitter: new DbToolAuditEmitter(db),
      // Phase 6: gate tool calls that require operator approval
      approvalGate: new DbToolApprovalGate(db),
      // Phase 4: credential and catalog injection
      credentialResolver: (id: string) => db.getToolCredential(id),
    };
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
  private async buildWorkersFromDb(
    workerRows: import('./db-types.js').WorkerAgentRow[],
    model: Model,
    toolOptions: ToolRegistryOptions,
    customTools?: import('@weaveintel/core').Tool[],
  ): Promise<Array<{ name: string; description: string; systemPrompt?: string; model: Model; tools?: ToolRegistry }>> {
    const sorted = [...workerRows].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return Promise.all(sorted.map(async (row) => {
      const toolNames = (this.safeParseJson(row.tool_names) as string[]) ?? [];
      const displayName = (row.display_name?.trim() || row.name).trim();
      const jobProfile = (row.job_profile?.trim() || 'Worker Agent').trim();
      const workerDescription = [
        `Display Name: ${displayName}`,
        `Job Profile: ${jobProfile}`,
        row.description,
      ].filter(Boolean).join('\n');
      const systemPrompt = applyTemporalToolPolicy({
        basePrompt: row.system_prompt ?? undefined,
        toolNames,
        temporalToolPolicy: TEMPORAL_TOOL_POLICY,
      });
      const persona = normalizePersona(row.persona ?? undefined, 'agent');
      const tools = toolNames.length
        ? await createToolRegistry(toolNames, customTools, { ...toolOptions, actorPersona: persona })
        : customTools?.length
          ? await createToolRegistry([], customTools, { ...toolOptions, actorPersona: persona })
          : undefined;

      return {
        name: row.name,
        description: workerDescription,
        systemPrompt,
        model,
        tools,
      };
    }));
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
    const hasActiveMandatorySkillPlan = Boolean(
      basePrompt && basePrompt.includes('MANDATORY EXECUTION PLAN'),
    );
    return buildSupervisorInstructionsPrompt({
      basePrompt,
      forceWorkerDataAnalysis,
      workerRows,
      prompts,
      hasActiveMandatorySkillPlan,
    });
  }

  /**
   * Phase 1B — resolve which DB-backed supervisor agent row applies to the
   * current chat. Errors are non-fatal: when resolution fails the runtime
   * falls back to the package defaults (geneweave-supervisor + utility tools).
   */
  private async resolveSupervisorContext(category: string): Promise<import('./db-types.js').ResolvedSupervisorAgent | null> {
    try {
      return await this.db.resolveSupervisorAgent({ category });
    } catch (err) {
      console.warn('[chat] resolveSupervisorAgent failed; using package defaults', err);
      return null;
    }
  }

  /**
   * Phase 2 — build a ToolRegistry of supervisor "additionalTools" from the
   * resolved agent's `agent_tools` allocations. These tools are exposed to
   * the supervisor directly (alongside utility tools and delegate_to_worker).
   * Workers' tool allocations are NOT included here (workers manage their own
   * tools). Returns `undefined` when there are no allocations or all fail.
   */
  private async buildSupervisorAdditionalTools(
    resolved: import('./db-types.js').ResolvedSupervisorAgent | null,
    toolOptions: ToolRegistryOptions,
  ): Promise<ToolRegistry | undefined> {
    return buildSupervisorAdditionalTools(resolved, toolOptions);
  }

  private async runWithCseSuccessGuard(
    agent: { run: (ctx: ExecutionContext, input: { messages: Message[]; goal: string }) => Promise<AgentResult> },
    ctx: ExecutionContext,
    messages: Message[],
    goal: string,
    enforce: boolean,
    enforceMandatorySkillPlan = false,
  ): Promise<AgentResult> {
    const first = await agent.run(ctx, { messages, goal });
    const firstPassesExecutionGuard = !enforce || (
      hasSuccessfulCseExecution(first)
      && hasCodeExecutorDelegation(first)
      && hasRenderableAttachmentAnalysisOutput(first, goal)
    );
    const firstPassesMandatoryPlan = !enforceMandatorySkillPlan || hasMandatoryBusinessDataPlanConformance(first);
    if (firstPassesExecutionGuard && firstPassesMandatoryPlan) return first;

    if (enforceMandatorySkillPlan && !firstPassesMandatoryPlan) {
      const delegationCount = countWorkerDelegations(first);
      return {
        ...first,
        output: `[Execution guard failure] Mandatory Business Data Analysis skill plan was selected but not followed. Observed worker delegations: ${delegationCount}. Required: ordered multi-pass delegations (Step 1→10 + Final) and final 10-section report with Composite Health Score and Priority-1 actions.`,
      };
    }

    const guardPolicy = await this.getPolicyPromptTemplate(POLICY_PROMPT_HARD_EXECUTION_GUARD, HARD_EXECUTION_GUARD_POLICY);
    const mandatoryPlanPolicy = enforceMandatorySkillPlan
      ? await this.getPolicyPromptTemplate(POLICY_PROMPT_MANDATORY_SKILL_PLAN_GUARD, MANDATORY_SKILL_PLAN_GUARD_POLICY)
      : '';
    const retryGoal = `${goal}\n\n${guardPolicy}${mandatoryPlanPolicy ? `\n\n${mandatoryPlanPolicy}` : ''}`;
    const second = await agent.run(ctx, { messages, goal: retryGoal });
    const secondPassesExecutionGuard =
      hasSuccessfulCseExecution(second)
      && hasCodeExecutorDelegation(second)
      && hasRenderableAttachmentAnalysisOutput(second, retryGoal);
    const secondPassesMandatoryPlan = !enforceMandatorySkillPlan || hasMandatoryBusinessDataPlanConformance(second);
    if (secondPassesExecutionGuard && secondPassesMandatoryPlan) return second;

    return {
      ...second,
      output: enforceMandatorySkillPlan
        ? '[Execution guard failure] The workflow did not satisfy the mandatory Business Data Analysis skill plan. Required: ordered multi-pass worker delegations (Step 1→10 + Final), plus a 10-section report with Composite Health Score and Priority-1 actions. Please retry.'
        : '[Execution guard failure] The workflow did not satisfy required execution constraints. A successful CSE run (`cse_run_code` or `cse_run_data_analysis`) through delegated worker "code_executor" is required, and the final result must be renderable (no sandbox-local file paths, no incomplete insights). Please retry.',
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
  ): Promise<SendMessageResult> {
    const deps: SendMessageDeps = {
      config: this.config,
      db: this.db,
      healthTracker: this.healthTracker,
      responseCache: this.responseCache,
      cacheKeyBuilder: this.cacheKeyBuilder,
      getAvailableModels: () => this.getAvailableModels(),
      withResponseCardFormatPolicy: (basePrompt) => this.withResponseCardFormatPolicy(basePrompt),
      runAgent: (ctx, model, userIdArg, chatIdArg, userPersona, messages, userContent, settings, attachments) =>
        this.runAgent(ctx, model, userIdArg, chatIdArg, userPersona, messages, userContent, settings, attachments),
      loadPricing: () => this.loadPricing(),
      recordModelOutcome: (modelIdArg, providerIdArg, latencyMsArg, successArg) =>
        this.recordModelOutcome(modelIdArg, providerIdArg, latencyMsArg, successArg),
      safeParseJson: (text) => this.safeParseJson(text),
    };

    return sendMessageImpl(deps, userId, chatId, content, opts);
  }

  // ── Stream mode ─────────────────────────────────────────────

  async streamMessage(
    res: ServerResponse,
    userId: string,
    chatId: string,
    content: string,
    opts?: { provider?: string; model?: string; maxTokens?: number; temperature?: number; attachments?: ChatAttachment[] },
  ): Promise<void> {
    return streamMessageImpl(
      {
        config: this.config,
        db: this.db,
        healthTracker: this.healthTracker,
        getAvailableModels: () => this.getAvailableModels(),
        withResponseCardFormatPolicy: (basePrompt) => this.withResponseCardFormatPolicy(basePrompt),
        streamAgent: (resArg, ctx, model, userIdArg, chatIdArg, userPersona, messages, userContent, settings, attachments) =>
          this.streamAgent(resArg, ctx, model, userIdArg, chatIdArg, userPersona, messages, userContent, settings, attachments),
        writeSseEvent: (resArg, payload) => this.writeSseEvent(resArg, payload),
        endSse: (resArg) => this.endSse(resArg),
        loadPricing: () => this.loadPricing(),
        recordModelOutcome: (modelIdArg, providerIdArg, latencyMsArg, successArg) =>
          this.recordModelOutcome(modelIdArg, providerIdArg, latencyMsArg, successArg),
        safeParseJson: (text) => this.safeParseJson(text),
      },
      res,
      userId,
      chatId,
      content,
      opts,
    );
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
    const [disabledToolKeys, catalogEntries] = await Promise.all([
      this.getDisabledBuiltinToolKeys(),
      this.db.listEnabledToolCatalog(),
    ]);
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
      catalogEntries,
      // Phase 6: apply active skill's tool policy key for scoped policy enforcement
      skillPolicyKey: settings.skillPolicyKey,
    };
    const customTools = enterpriseTools.length > 0 ? enterpriseTools : undefined;
    const tools = settings.enabledTools.length
      ? await createToolRegistry(settings.enabledTools, customTools, toolOptions)
      : customTools?.length ? await createToolRegistry([], customTools, toolOptions) : undefined;

    const agentBus = weaveEventBus();
    const toolCallObserver = observeToolCallEvents(agentBus);

    try {
      const forceWorkerDataAnalysis = shouldForceWorkerDataAnalysis(userContent, attachments);
      // When an active skill defines a mandatory multi-step plan, do not inject
      // the generic 2-step "code_executor then analyst" requirement into the goal.
      const hasActiveMandatorySkillPlan = Boolean(settings.systemPrompt?.includes('MANDATORY EXECUTION PLAN'));
      const enforceMandatorySkillPlan = forceWorkerDataAnalysis && hasActiveMandatorySkillPlan;
      const forceWorkerRequirement = await this.getPolicyPromptTemplate(
        POLICY_PROMPT_FORCED_WORKER_REQUIREMENT,
        FORCED_WORKER_REQUIREMENT,
      );
      const effectiveGoal = forceWorkerDataAnalysis && !hasActiveMandatorySkillPlan
        ? `${userContent}\n\n${forceWorkerRequirement}`
        : userContent;

      // Load DB-driven worker agents for supervisor mode
      const dbWorkerRows = (settings.mode === 'supervisor' || (settings.mode === 'agent' && hasEnterprise))
        ? await this.db.listEnabledWorkerAgents()
        : [];

      const routedGoal = effectiveGoal;

      // Auto-upgrade to supervisor when enterprise tools are available
      let agent;
      let systemPromptSha256: string = '';
      
      if (settings.mode === 'supervisor' || (settings.mode === 'agent' && hasEnterprise)) {
        const baseWorkers = settings.workers.length > 0
          ? await Promise.all(settings.workers.map(async (w) => ({
              name: w.name,
              description: w.description,
              systemPrompt: applyTemporalToolPolicy({
                basePrompt: undefined,
                toolNames: w.tools,
                temporalToolPolicy: TEMPORAL_TOOL_POLICY,
              }),
              model,
              tools: w.tools.length
                ? await createToolRegistry(w.tools, customTools, { ...toolOptions, actorPersona: normalizePersona(w.persona, 'agent') })
                : customTools?.length
                  ? await createToolRegistry([], customTools, { ...toolOptions, actorPersona: normalizePersona(w.persona, 'agent') })
                  : undefined,
            })))
          : await this.buildWorkersFromDb(dbWorkerRows, model, toolOptions, customTools);
        // Build enterprise domain workers from tool groups
        const enterpriseWorkers = await Promise.all(enterpriseToolGroups.map(async (g) => {
          const registry = await createToolRegistry([], g.tools, { ...toolOptions, actorPersona: 'agent_researcher' });
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
        // Supervisor's direct toolset is now package-managed: think, plan,
        // delegate_to_worker, plus the utility tools (datetime, math_eval,
        // unit_convert) provided by @weaveintel/agents. CSE tools live on
        // the `code_executor` worker; the supervisor must delegate to it.
        // (Retain `skillContributedTools` plumbing — it is still consulted
        // by skill activation code paths elsewhere.)

        const resolvedSupervisor = await this.resolveSupervisorContext('general');
        const supervisorBasePrompt = [
          resolvedSupervisor?.agent.system_prompt,
          settings.systemPrompt,
        ].filter((value): value is string => Boolean(value && value.trim())).join('\n\n');
        const supervisorInstructions = await this.buildSupervisorInstructions(supervisorBasePrompt, forceWorkerDataAnalysis, dbWorkerRows);
        const supervisorAdditionalTools = await this.buildSupervisorAdditionalTools(resolvedSupervisor, toolOptions);
        systemPromptSha256 = computePromptFingerprint(supervisorInstructions);

        agent = weaveAgent({
          model,
          workers: allWorkers,
          maxSteps: 20,
          name: resolvedSupervisor?.agent.name ?? 'geneweave-supervisor',
          systemPrompt: supervisorInstructions,
          defaultTimezone: resolvedSupervisor?.agent.default_timezone ?? settings.timezone,
          includeUtilityTools: resolvedSupervisor ? resolvedSupervisor.agent.include_utility_tools !== 0 : true,
          additionalTools: supervisorAdditionalTools,
          bus: agentBus,
        });
      } else {
        const policyPrompt = await this.withResponseCardFormatPolicy(applyTemporalToolPolicy({
          basePrompt: settings.systemPrompt,
          toolNames: settings.enabledTools,
          temporalToolPolicy: TEMPORAL_TOOL_POLICY,
        }));
        systemPromptSha256 = computePromptFingerprint(policyPrompt);
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
        enforceMandatorySkillPlan,
      );
      return { result, toolCallEvents: toolCallObserver.events, systemPromptSha256 };
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
    const [disabledToolKeys, catalogEntries] = await Promise.all([
      this.getDisabledBuiltinToolKeys(),
      this.db.listEnabledToolCatalog(),
    ]);
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
      catalogEntries,
      // Phase 6: apply active skill's tool policy key for scoped policy enforcement
      skillPolicyKey: settings.skillPolicyKey,
    };
    const customTools = enterpriseTools.length > 0 ? enterpriseTools : undefined;
    const tools = settings.enabledTools.length
      ? await createToolRegistry(settings.enabledTools, customTools, toolOptions)
      : customTools?.length ? await createToolRegistry([], customTools, toolOptions) : undefined;

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
            void this.writeSseEvent(res, { type: 'screenshot', base64: parsed.base64, format: parsed.format || 'png' });
          }
        } catch { /* not JSON or no base64 — ignore */ }
      }
    });

    try {
      const forceWorkerDataAnalysis = shouldForceWorkerDataAnalysis(userContent, attachments);
      const hasActiveMandatorySkillPlanStream = Boolean(settings.systemPrompt?.includes('MANDATORY EXECUTION PLAN'));
      const enforceMandatorySkillPlanStream = forceWorkerDataAnalysis && hasActiveMandatorySkillPlanStream;
      const forceWorkerRequirement = await this.getPolicyPromptTemplate(
        POLICY_PROMPT_FORCED_WORKER_REQUIREMENT,
        FORCED_WORKER_REQUIREMENT,
      );
      const effectiveGoal = forceWorkerDataAnalysis && !hasActiveMandatorySkillPlanStream
        ? `${userContent}\n\n${forceWorkerRequirement}`
        : userContent;
      const dbWorkerRows = (settings.mode === 'supervisor' || (settings.mode === 'agent' && hasEnterprise))
        ? await this.db.listEnabledWorkerAgents()
        : [];
      const routedGoal = effectiveGoal;
      let agent;
      if (settings.mode === 'supervisor' || (settings.mode === 'agent' && hasEnterprise)) {
        const baseWorkers = settings.workers.length > 0
          ? await Promise.all(settings.workers.map(async (w) => ({
              name: w.name,
              description: w.description,
              systemPrompt: applyTemporalToolPolicy({
                basePrompt: undefined,
                toolNames: w.tools,
                temporalToolPolicy: TEMPORAL_TOOL_POLICY,
              }),
              model,
              tools: w.tools.length
                ? await createToolRegistry(w.tools, customTools, { ...toolOptions, actorPersona: normalizePersona(w.persona, 'agent') })
                : customTools?.length
                  ? await createToolRegistry([], customTools, { ...toolOptions, actorPersona: normalizePersona(w.persona, 'agent') })
                  : undefined,
            })))
          : await this.buildWorkersFromDb(dbWorkerRows, model, toolOptions, customTools);
        const enterpriseWorkers = await Promise.all(enterpriseToolGroups.map(async (g) => {
          const registry = await createToolRegistry([], g.tools, { ...toolOptions, actorPersona: 'agent_researcher' });
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
        // Streaming path: same supervisor tool contract as the non-streaming
        // path — supervisor gets package defaults (think/plan/datetime/
        // math_eval/unit_convert/delegate_to_worker) and nothing else. CSE
        // belongs to the `code_executor` worker.

        const resolvedSupervisor = await this.resolveSupervisorContext('general');
        const supervisorBasePrompt = [
          resolvedSupervisor?.agent.system_prompt,
          settings.systemPrompt,
        ].filter((value): value is string => Boolean(value && value.trim())).join('\n\n');
        const supervisorInstructions = await this.buildSupervisorInstructions(supervisorBasePrompt, forceWorkerDataAnalysis, dbWorkerRows);
        const supervisorAdditionalTools = await this.buildSupervisorAdditionalTools(resolvedSupervisor, toolOptions);
        agent = weaveAgent({
          model,
          workers: allWorkers,
          maxSteps: 20,
          name: resolvedSupervisor?.agent.name ?? 'geneweave-supervisor',
          systemPrompt: supervisorInstructions,
          defaultTimezone: resolvedSupervisor?.agent.default_timezone ?? settings.timezone,
          includeUtilityTools: resolvedSupervisor ? resolvedSupervisor.agent.include_utility_tools !== 0 : true,
          additionalTools: supervisorAdditionalTools,
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

    if (forceWorkerDataAnalysis) {
      const guarded = await this.runWithCseSuccessGuard(agent, ctx, messages, routedGoal, true, enforceMandatorySkillPlanStream);
      await this.writeSseEvent(res, { type: 'text', text: guarded.output });
      for (const step of guarded.steps) {
        await this.writeSseEvent(res, {
          type: 'step',
          step: { index: step.index, type: step.type, content: step.content, toolCall: step.toolCall, delegation: step.delegation, durationMs: step.durationMs },
          phase: 'step_end',
        });
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
              await this.writeSseEvent(res, {
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
              });
            }
            break;
          case 'text_chunk':
            if (event.text) {
              await this.writeSseEvent(res, { type: 'text', text: event.text });
            }
            break;
          case 'tool_start':
            if (event.step?.toolCall) {
              await this.writeSseEvent(res, {
                type: 'tool_start',
                name: event.step.toolCall.name,
                arguments: event.step.toolCall.arguments,
              });
            }
            break;
          case 'tool_end':
            if (event.step?.toolCall) {
              await this.writeSseEvent(res, {
                type: 'tool_end',
                name: event.step.toolCall.name,
                result: event.step.toolCall.result,
                durationMs: event.step.durationMs,
              });
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
    await this.writeSseEvent(res, { type: 'text', text: result.output });

    // Send step summaries
    for (const step of result.steps) {
      await this.writeSseEvent(res, {
        type: 'step',
        step: { index: step.index, type: step.type, content: step.content, toolCall: step.toolCall, delegation: step.delegation, durationMs: step.durationMs },
        phase: 'step_end',
      });
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
