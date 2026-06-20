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

import { newUUIDv7, createLogger } from '@weaveintel/core';
import type { DurableConsentManager } from '@weaveintel/compliance';

const log = createLogger('chat');
import type { ServerResponse } from 'node:http';
import type {
  Model, ModelRequest, ModelResponse, StreamChunk, ExecutionContext, Message,
  Tool, ToolRegistry, AgentStepEvent, AgentStep, AgentResult, EventBus, Agent,
} from '@weaveintel/core';
import { weaveContext, weaveEventBus, EventTypes } from '@weaveintel/core';
import { weaveAgent, weaveEnsemble, createVoteResolver, createArbiterResolver } from '@weaveintel/agents';
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
import { ModelHealthTracker, createRuntimeRoutingAdapter } from '@weaveintel/routing';
import type { RuntimeRoutingSlot } from '@weaveintel/core';
import {
  getP99Latency,
  getLatencySnapshot,
  DEGRADATION_MULTIPLIER,
  MIN_DEGRADATION_LATENCY_MS,
  DEGRADATION_BLOCK_MS,
} from '@weaveintel/resilience';
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
  applyGovernanceCheck,
} from './chat-memory-utils.js';
import { getActiveSemanticMemoryBackend } from './memory-pgvector.js';
import { getActiveGuardrailEmbeddingModel } from './guardrail-judge.js';
import { triggerConsolidationForUser } from './memory-consolidation.js';
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
  countWorkerDelegations,
  evaluateSkillExecutionContracts,
  formatExecutionContractFailures,
  hasCodeExecutorDelegation,
  hasSuccessfulCseExecution,
} from './chat-cse-utils.js';
import { extractSkillExecutionContractsFromPrompt, type ResolvedSkillExecutionContract } from '@weaveintel/skills';
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
import { resolveLimits } from './platform-limits.js';

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
    log.warn('buildSupervisorAdditionalTools failed; supervisor will use defaults only', { err: String(err) });
    return undefined;
  }
}

export class ChatEngine {
  private readonly healthTracker: RuntimeRoutingSlot;
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

  // M5-3: consent manager for gating AI-derived memory writes.
  // Permit-if-no-record — only blocks when an explicit consent flag has expired.
  private readonly consentManager: DurableConsentManager | null;

  constructor(
    private readonly config: ChatEngineConfig,
    private readonly db: DatabaseAdapter,
  ) {
    // Phase 2: use the shared routing slot from the runtime when available so
    // both the chat path and the live-agent supervisor observe the same health
    // state. Fall back to a local tracker when no runtime is wired (tests, etc.).
    this.healthTracker = config.runtime?.routing
      ?? createRuntimeRoutingAdapter(new ModelHealthTracker());
    // Phase 6: pull from the runtime compliance slot (shared across all chat engines)
    // rather than creating a per-engine manager. Structurally compatible with
    // DurableConsentManager — cast is safe at runtime.
    this.consentManager = (config.runtime?.compliance?.consent ?? null) as DurableConsentManager | null;
    this.toolOptions = {
      temporalStore: createTemporalStore(db),
      policyResolver: new DbToolPolicyResolver(db),
      rateLimiter: new DbToolRateLimiter(db),
      auditEmitter: new DbToolAuditEmitter(db),
      // Phase 6: gate tool calls that require operator approval
      approvalGate: new DbToolApprovalGate(db),
      // Phase 4: credential and catalog injection
      credentialResolver: (id: string) => db.getToolCredential(id),
      // Phase D: runtime propagation for capability requires assertion
      ...(config.runtime ? { runtime: config.runtime } : {}),
    };
  }

  /** Permit-if-no-record consent check. Returns true when writing is allowed. */
  private async isPersonalizationAllowed(userId: string): Promise<boolean> {
    if (!this.consentManager) return true;
    try {
      const flags = await this.consentManager.listBySubject(userId);
      const flag = flags.find(f => f.purpose === 'personalization');
      if (!flag) return true; // no record → allow
      return this.consentManager.isGranted(userId, 'personalization');
    } catch { return true; } // fail-open on transient KV error
  }

  /**
   * Public, read-only view of the model configuration (providers + default
   * provider/model + runtime). Consumed by the `/api/me/runs` executor to
   * resolve the default model without re-deriving provider wiring.
   */
  get modelConfig(): ChatEngineConfig {
    return this.config;
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
      const toolNamesRaw = this.safeParseJson(row.tool_names);
      const toolNames = Array.isArray(toolNamesRaw) ? (toolNamesRaw as string[]) : [];
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
    const hasActiveMandatorySkillPlan = extractSkillExecutionContractsFromPrompt(basePrompt).length > 0;
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
      log.warn('resolveSupervisorAgent failed; using package defaults', { err: String(err) });
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
  /** Public entry-point for A2A task execution — delegates to the internal agent runner. */
  async runAgentTask(
    ctx: ExecutionContext,
    model: Model,
    userId: string,
    chatId: string,
    userPersona: string,
    messages: Message[],
    userContent: string,
    settings: ChatSettings,
    attachments?: ChatAttachment[],
    tenantId?: string | null,
  ): Promise<AgentRunTelemetry> {
    return this.runAgent(ctx, model, userId, chatId, userPersona, messages, userContent, settings, attachments, tenantId);
  }

  private async runWithCseSuccessGuard(
    agent: { run: (ctx: ExecutionContext, input: { messages: Message[]; goal: string }) => Promise<AgentResult> },
    ctx: ExecutionContext,
    messages: Message[],
    goal: string,
    enforce: boolean,
    skillExecutionContracts: readonly ResolvedSkillExecutionContract[] = [],
  ): Promise<AgentResult> {
    const enforceContracts = skillExecutionContracts.length > 0;
    // When an active skill defines its own executionContract, that contract is
    // the source of truth for delegation requirements. The legacy
    // `hasCodeExecutorDelegation` check is bypassed because some skills (e.g.
    // skill-data-analysis-execution) intentionally execute CSE tools directly
    // without going through the code_executor worker. We still enforce
    // hasSuccessfulCseExecution + hasRenderableAttachmentAnalysisOutput.
    const first = await agent.run(ctx, { messages, goal });
    const firstPassesExecutionGuard = !enforce || (
      hasSuccessfulCseExecution(first)
      && (enforceContracts || hasCodeExecutorDelegation(first))
      && hasRenderableAttachmentAnalysisOutput(first, goal)
    );
    const firstContractEval = enforceContracts
      ? evaluateSkillExecutionContracts(first, skillExecutionContracts)
      : { ok: true, failures: [] };
    if (firstPassesExecutionGuard && firstContractEval.ok) return first;

    const guardPolicy = await this.getPolicyPromptTemplate(POLICY_PROMPT_HARD_EXECUTION_GUARD, HARD_EXECUTION_GUARD_POLICY);
    const contractRetryHints = enforceContracts && !firstContractEval.ok
      ? `\n\nSKILL EXECUTION CONTRACT — concrete failures from your previous attempt that you must fix:\n${formatExecutionContractFailures(firstContractEval.failures)}\nProduce a complete final response that satisfies every item above.`
      : '';
    const retryGoal = `${goal}\n\n${guardPolicy}${contractRetryHints}`;
    const second = await agent.run(ctx, { messages, goal: retryGoal });
    const secondPassesExecutionGuard =
      hasSuccessfulCseExecution(second)
      && (enforceContracts || hasCodeExecutorDelegation(second))
      && hasRenderableAttachmentAnalysisOutput(second, retryGoal);
    const secondContractEval = enforceContracts
      ? evaluateSkillExecutionContracts(second, skillExecutionContracts)
      : { ok: true, failures: [] };
    if (secondPassesExecutionGuard && secondContractEval.ok) return second;

    if (enforceContracts && !secondContractEval.ok) {
      return {
        ...second,
        output: `[Execution guard failure] The skill execution contract was not satisfied after retry:\n${formatExecutionContractFailures(secondContractEval.failures)}`,
      };
    }

    return {
      ...second,
      output: '[Execution guard failure] The workflow did not satisfy required execution constraints. A successful CSE run (`cse_run_code` or `cse_run_data_analysis`) through delegated worker "code_executor" is required, and the final result must be renderable (no sandbox-local file paths, no incomplete insights). Please retry.',
    };
  }

  /** Load pricing from DB, cache for 60 s */
  private async loadPricing(): Promise<Map<string, ModelPricing>> {
    const result = await loadModelPricing(this.db, this.pricingCache);
    this.pricingCache = result.cache;
    return result.pricing;
  }

  /**
   * Shared implementation for the `memory_forget` tool callback.
   * Removes the named entity from entity memory AND any semantic memory
   * entry whose stored text contains `entityName` (case-insensitive
   * substring). Returns per-store deletion counts; never throws.
   */
  private async forgetMemoryForUser(
    ctx: ExecutionContext,
    userId: string,
    entityName: string,
  ): Promise<{ ok: boolean; deletedEntities: number; deletedSemantic: number }> {
    let entityError = false;
    let deletedEntities = 0;
    try { deletedEntities = await this.db.deleteEntity(userId, entityName); }
    catch (err) { log.warn('memory_forget entity delete failed', { err: String(err) }); entityError = true; }
    let semanticError = false;
    let deletedSemantic = 0;
    try {
      const memBackend = getActiveSemanticMemoryBackend();
      if (memBackend) {
        const r = await memBackend.forget(ctx, { userId, needle: entityName });
        deletedSemantic = r.deleted;
      } else {
        const rows = await this.db.listSemanticMemory(userId, 1000);
        const needle = entityName.toLowerCase();
        for (const row of rows) {
          if (row.content.toLowerCase().includes(needle)) {
            try { await this.db.deleteSemanticMemory(row.id, userId); deletedSemantic += 1; }
            catch { /* best-effort */ }
          }
        }
      }
    } catch (err) {
      log.warn('memory_forget semantic delete failed', { err: String(err) });
      semanticError = true;
    }
    return { ok: !(entityError && semanticError), deletedEntities, deletedSemantic };
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
      runAgent: (ctx, model, userIdArg, chatIdArg, userPersona, messages, userContent, settings, attachments, tenantIdArg) =>
        this.runAgent(ctx, model, userIdArg, chatIdArg, userPersona, messages, userContent, settings, attachments, tenantIdArg),
      loadPricing: () => this.loadPricing(),
      recordModelOutcome: (modelIdArg, providerIdArg, latencyMsArg, successArg, errMsg) =>
        this.recordModelOutcome(modelIdArg, providerIdArg, latencyMsArg, successArg, errMsg),
      safeParseJson: (text) => this.safeParseJson(text),
      consentManager: this.consentManager,
    };

    return sendMessageImpl(deps, userId, chatId, content, opts);
  }

  // ── Stream mode ─────────────────────────────────────────────

  /** Optional hook registered by the routes layer to react to policy checks post-stream. */
  onPolicyChecks?: (userId: string, checks: Array<{ tool: string; policy: string; taskType: string; priority: string }>) => Promise<void>;

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
        streamAgent: (resArg, ctx, model, userIdArg, chatIdArg, userPersona, messages, userContent, settings, attachments, tenantIdArg) =>
          this.streamAgent(resArg, ctx, model, userIdArg, chatIdArg, userPersona, messages, userContent, settings, attachments, tenantIdArg),
        writeSseEvent: (resArg, payload) => this.writeSseEvent(resArg, payload),
        endSse: (resArg) => this.endSse(resArg),
        loadPricing: () => this.loadPricing(),
        recordModelOutcome: (modelIdArg, providerIdArg, latencyMsArg, successArg) =>
          this.recordModelOutcome(modelIdArg, providerIdArg, latencyMsArg, successArg),
        safeParseJson: (text) => this.safeParseJson(text),
        onPolicyChecks: this.onPolicyChecks,
        consentManager: this.consentManager,
      },
      res,
      userId,
      chatId,
      content,
      opts,
    );
  }

  // ── Enterprise tools loader ─────────────────────────────────

  // ── Memory query helper (M-17) ──────────────────────────────────────────────
  // Shared by memoryRecall and memorySearch callbacks — differs only in return shape.

  private async executeMemoryQuery(
    ctx: ExecutionContext,
    userId: string,
    query: string,
    limit: number | undefined,
    callerLabel: string,
  ): Promise<{
    semantic: Array<{ content: string; source: string; memory_type?: string }>;
    entities: Array<{ entity_type: string; entity_name: string; facts: string }>;
  }> {
    const boundedLimit = Math.max(1, Math.min(20, limit ?? 5));
    const memBackend = getActiveSemanticMemoryBackend();
    let queryEmbedding: number[] | undefined;
    try {
      const embModel = getActiveGuardrailEmbeddingModel();
      if (embModel) {
        const embRes = await embModel.embed(ctx, { input: [query.slice(0, 2000)] });
        queryEmbedding = embRes.embeddings[0] as number[] | undefined;
      }
    } catch (embErr) {
      // L-17: log embedding failures so operators can diagnose model outages;
      // best-effort fallback to text-only search is correct here.
      log.warn(`${callerLabel} embedding failed`, { err: embErr instanceof Error ? embErr.message : String(embErr) });
    }
    const [semantic, entityRows] = await Promise.all([
      memBackend
        ? memBackend.search(ctx, { userId, query, limit: boundedLimit, queryEmbedding })
        : this.db.searchSemanticMemory({ userId, query, limit: boundedLimit, queryEmbedding }),
      this.db.searchEntities(userId, query),
    ]);
    return {
      semantic: semantic.map((m) => ({ content: m.content, source: m.source, memory_type: m.memory_type })),
      entities: entityRows,
    };
  }

  // ── Memory tool callbacks (5.4) ───────────────────────────────────────────
  // Extracted from buildAgentToolOptions so each concern lives in one place.

  private buildMemoryToolCallbacks(ctx: ExecutionContext): Pick<ToolRegistryOptions,
    'memoryRecall' | 'memorySearch' | 'memoryRemember' | 'memoryForget' |
    'memoryListEntities' | 'memoryListEpisodes' | 'memoryGetProfile' |
    'memorySaveSnapshot' | 'memoryLoadSnapshot' | 'memoryProposeInstruction'
  > {
    return {
      memoryRecall: async ({ userId: recallUserId, query, limit }) => {
        // M-17: delegates to executeMemoryQuery() — avoids duplicating the
        // embedding + dual-store search logic that memorySearch shares.
        const { semantic, entities } = await this.executeMemoryQuery(ctx, recallUserId, query, limit, 'memoryRecall');
        return {
          semantic: semantic.map((m) => ({ content: m.content, source: m.source })),
          entities: entities.map((e) => ({
            entityType: e.entity_type,
            entityName: e.entity_name,
            facts: (this.safeParseJson(e.facts) as Record<string, unknown>) ?? {},
          })),
        };
      },
      memorySearch: async ({ userId: searchUserId, query, limit }) => {
        // M-17: delegates to executeMemoryQuery(); returns memoryType which recall omits.
        const { semantic, entities } = await this.executeMemoryQuery(ctx, searchUserId, query, limit, 'memorySearch');
        return {
          semantic: semantic.map((m) => ({ content: m.content, source: m.source, memoryType: m.memory_type ?? '' })),
          entities: entities.map((e) => ({
            entityType: e.entity_type,
            entityName: e.entity_name,
            facts: (this.safeParseJson(e.facts) as Record<string, unknown>) ?? {},
          })),
        };
      },
      memoryRemember: async ({ userId: rememberUserId, content, memoryType, source }) => {
        const { newUUIDv7 } = await import('@weaveintel/core');
        const memBackend = getActiveSemanticMemoryBackend();
        const trimmedContent = content.slice(0, 600);
        const govResult = await applyGovernanceCheck(this.db, ctx, trimmedContent, 'semantic');
        if (govResult.blocked) {
          throw new Error('Memory governance policy blocked this content from being stored.');
        }
        const safeContent = govResult.content;
        const id = newUUIDv7();
        let embedding: number[] | undefined;
        try {
          const embModel = getActiveGuardrailEmbeddingModel();
          if (embModel) {
            const embRes = await embModel.embed(ctx, { input: [safeContent] });
            embedding = Array.from(embRes.embeddings[0] ?? []) as number[];
            if (embedding.length === 0) embedding = undefined;
          }
        } catch (embErr) {
          log.warn('memory_remember embedding failed', { err: String(embErr) });
        }
        const saveOpts = { id, userId: rememberUserId, content: safeContent, memoryType: memoryType ?? 'user_fact', source: source ?? 'user_requested', embedding };
        await (memBackend ? memBackend.save(ctx, saveOpts) : this.db.saveSemanticMemory(saveOpts));
        return { id };
      },
      memoryForget: async ({ userId: forgetUserId, entityName }) => {
        return await this.forgetMemoryForUser(ctx, forgetUserId, entityName);
      },
      memoryListEntities: async ({ userId: listUserId }) => {
        const rows = await this.db.listEntities(listUserId);
        return {
          entities: rows.map((e) => ({
            entityType: e.entity_type,
            entityName: e.entity_name,
            facts: (this.safeParseJson(e.facts) as Record<string, unknown>) ?? {},
            confidence: e.confidence,
          })),
        };
      },
      memoryListEpisodes: async ({ userId: epUserId, limit }) => {
        const rows = await this.db.listEpisodicMemory(epUserId, Math.min(30, limit ?? 10));
        return {
          episodes: rows.map((r) => ({
            id: r.id,
            messageRole: r.message_role,
            content: r.content,
            importance: r.importance,
            createdAt: r.created_at,
          })),
        };
      },
      memoryGetProfile: async ({ userId: profUserId }) => {
        const [entityRows, semanticRows, episodicRows, proceduralRows] = await Promise.all([
          this.db.listEntities(profUserId),
          this.db.listSemanticMemory(profUserId, 20),
          this.db.listEpisodicMemory(profUserId, 10),
          this.db.listAppliedProcedural(profUserId),
        ]);
        return {
          entities: entityRows.map((e) => ({
            entityType: e.entity_type,
            entityName: e.entity_name,
            facts: (this.safeParseJson(e.facts) as Record<string, unknown>) ?? {},
            confidence: e.confidence,
          })),
          semantic: semanticRows.map((m) => ({ content: m.content, memoryType: m.memory_type, source: m.source })),
          episodic: episodicRows.map((ep) => ({ messageRole: ep.message_role, content: ep.content, createdAt: ep.created_at })),
          procedural: proceduralRows.map((p) => ({ instructionDelta: p.instruction_delta, appliedAt: p.applied_at ?? '' })),
        };
      },
      memorySaveSnapshot: async ({ userId: snapUserId, chatId: snapChatId, agentId: snapAgentId, state }) => {
        const { newUUIDv7 } = await import('@weaveintel/core');
        const id = newUUIDv7();
        await this.db.saveWorkingMemorySnapshot({ id, userId: snapUserId, chatId: snapChatId, agentId: snapAgentId ?? 'default', content: state });
        return { id };
      },
      memoryLoadSnapshot: async ({ userId: snapUserId, agentId: snapAgentId }) => {
        const snapshot = await this.db.getLatestWorkingMemory(snapUserId, snapAgentId ?? 'default');
        if (!snapshot) return { snapshot: null, id: null, savedAt: null };
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(snapshot.content) as Record<string, unknown>; } catch { parsed = { raw: snapshot.content }; }
        return { snapshot: parsed, id: snapshot.id, savedAt: snapshot.created_at };
      },
      memoryProposeInstruction: async ({ userId: propUserId, agentId: propAgentId, instruction, reason, confidence }) => {
        // M5-3: check personalization consent before AI-derived memory write.
        if (!(await this.isPersonalizationAllowed(propUserId))) {
          return { id: 'consent-denied' };
        }
        const { newUUIDv7 } = await import('@weaveintel/core');
        const id = `proc-${newUUIDv7().slice(-8)}`;
        await this.db.createProceduralMemory({
          id,
          user_id: propUserId,
          agent_id: propAgentId ?? 'default',
          instruction_delta: reason ? `${instruction}\n\nReason: ${reason}` : instruction,
          proposed_by: 'agent',
          status: 'proposed',
          confidence: confidence ?? 0.75,
          human_task_id: null,
          applied_at: null,
        });
        return { id };
      },
    };
  }

  // ── Agenda tool callbacks (5.4) ───────────────────────────────────────────

  private buildAgendaToolCallbacks(): Pick<ToolRegistryOptions,
    'agendaList' | 'agendaFindSimilar' | 'agendaCreate' | 'agendaUpdate' | 'agendaDelete'
  > {
    return {
      agendaList: async ({ userId: agendaUserId, startAt, endAt, kind, limit, search }) => {
        const items = await this.db.listAgendaItems(agendaUserId, {
          startAt,
          endAt,
          kind: kind as import('./db-types/adapter-agenda-notes.js').AgendaItemKind | undefined,
          limit: limit ?? 10,
          search,
        });
        return items.map((item) => ({
          id: item.id,
          title: item.title,
          kind: item.kind,
          status: item.status,
          start_at: item.start_at,
          end_at: item.end_at,
          all_day: item.all_day,
          location: item.location,
          description: item.description,
          created_at: item.created_at,
        }));
      },
      agendaFindSimilar: async ({ userId: agendaUserId, title, dateBucket }) => {
        const similar = await this.db.findSimilarAgendaItems(agendaUserId, title, dateBucket);
        return similar.map(item => ({ id: item.id, title: item.title, kind: item.kind, start_at: item.start_at }));
      },
      agendaCreate: async ({ userId: agendaUserId, title, kind, startAt, endAt, allDay, location, description }) => {
        if (!(await this.isPersonalizationAllowed(agendaUserId))) {
          return { id: 'consent-denied', title, kind: kind ?? 'event', start_at: startAt ?? null };
        }
        const { newUUIDv7 } = await import('@weaveintel/core');
        const id = newUUIDv7();
        await this.db.createAgendaItem({
          id,
          user_id: agendaUserId,
          tenant_id: null,
          title,
          kind: (kind ?? 'event') as import('./db-types/adapter-agenda-notes.js').AgendaItemKind,
          category_id: null,
          start_at: startAt ?? null,
          end_at: endAt ?? null,
          all_day: allDay ? 1 : 0,
          location: location ?? null,
          description: description ?? null,
          recurrence_rule: null,
          status: 'confirmed',
          sensitivity: 'normal',
          amount: null,
          currency: null,
          provenance: JSON.stringify({ source: 'agent' }),
        });
        const item = await this.db.getAgendaItem(id, agendaUserId);
        return { id, title: item?.title ?? title, kind: item?.kind ?? (kind ?? 'event'), start_at: item?.start_at ?? startAt ?? null };
      },
      agendaUpdate: async ({ userId: agendaUserId, id, title, kind, startAt, endAt, allDay, location, description, status }) => {
        const patch: Record<string, unknown> = {};
        if (title !== undefined) patch['title'] = title;
        if (kind !== undefined) patch['kind'] = kind;
        if (startAt !== undefined) patch['start_at'] = startAt;
        if (endAt !== undefined) patch['end_at'] = endAt;
        if (allDay !== undefined) patch['all_day'] = allDay ? 1 : 0;
        if (location !== undefined) patch['location'] = location;
        if (description !== undefined) patch['description'] = description;
        if (status !== undefined) patch['status'] = status;
        await this.db.updateAgendaItem(id, agendaUserId, patch as Parameters<typeof this.db.updateAgendaItem>[2]);
        const item = await this.db.getAgendaItem(id, agendaUserId);
        if (!item) return null;
        return { id: item.id, title: item.title, start_at: item.start_at };
      },
      agendaDelete: async ({ userId: agendaUserId, id }) => {
        const deleted = await this.db.deleteAgendaItem(id, agendaUserId);
        return { deleted: !!deleted };
      },
    };
  }

  // ── Shared tool options builder (R-2: deduplicates runAgent / streamAgent) ──

  private buildAgentToolOptions(
    ctx: ExecutionContext,
    userId: string,
    chatId: string,
    userPersona: string,
    settings: ChatSettings,
    attachments: ChatAttachment[] | undefined,
    disabledToolKeys: ReadonlySet<string>,
    catalogEntries: import('./db-types.js').ToolCatalogRow[],
  ): ToolRegistryOptions {
    return {
      ...this.toolOptions,
      defaultTimezone: settings.timezone,
      currentUserId: userId,
      currentChatId: chatId,
      currentAttachments: attachments,
      actorPersona: userPersona,
      ...this.buildMemoryToolCallbacks(ctx),
      ...this.buildAgendaToolCallbacks(),
      disabledToolKeys,
      catalogEntries,
      skillPolicyKey: settings.skillPolicyKey,
      explicitEnabledTools: settings.enabledTools,
    };
  }

  // ── Shared agent instance builder (H-12) ─────────────────────────────────
  // Extracted from the ~250-line duplicated block that existed verbatim in both
  // runAgent() and streamAgent(). Both callers now share one code path for:
  //   - forceWorkerDataAnalysis / skill contract detection
  //   - effectiveGoal / routedGoal construction
  //   - dbWorkerRows loading
  //   - supervisor / ensemble / single-agent construction
  // The agentBus is passed in because streamAgent wires screenshot events on it
  // before calling this method.

  private async buildAgentInstance(opts: {
    ctx: ExecutionContext;
    model: Model;
    userContent: string;
    settings: ChatSettings;
    attachments: ChatAttachment[] | undefined;
    limits: Awaited<ReturnType<typeof resolveLimits>>;
    tools: ToolRegistry | undefined;
    customTools: Tool[] | undefined;
    enterpriseToolGroups: EnterpriseToolGroup[];
    toolOptions: ReturnType<ChatEngine['buildAgentToolOptions']>;
    agentBus: EventBus;
    hasEnterprise: boolean;
  }): Promise<{
    agent: Agent;
    systemPromptSha256: string;
    routedGoal: string;
    forceWorkerDataAnalysis: boolean;
    skillExecutionContracts: ResolvedSkillExecutionContract[];
  }> {
    const { ctx, model, userContent, settings, attachments, limits, tools, customTools, enterpriseToolGroups, toolOptions, agentBus, hasEnterprise } = opts;

    const forceWorkerDataAnalysis = shouldForceWorkerDataAnalysis(userContent, attachments);
    const skillExecutionContracts = extractSkillExecutionContractsFromPrompt(settings.systemPrompt);
    const hasActiveMandatorySkillPlan = skillExecutionContracts.length > 0;
    const forceWorkerRequirement = await this.getPolicyPromptTemplate(
      POLICY_PROMPT_FORCED_WORKER_REQUIREMENT,
      FORCED_WORKER_REQUIREMENT,
    );
    const effectiveGoal = forceWorkerDataAnalysis && !hasActiveMandatorySkillPlan
      ? `${userContent}\n\n${forceWorkerRequirement}`
      : userContent;
    const dbWorkerRows = (settings.mode === 'supervisor' || (settings.mode === 'agent' && hasEnterprise))
      ? await this.db.listEnabledWorkerAgents()
      : [];
    const routedGoal = effectiveGoal;

    let agent: Agent;
    let systemPromptSha256 = '';

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
      log.info('supervisor ready', { workers: allWorkers.length, baseWorkers: baseWorkers.length, enterpriseWorkers: enterpriseWorkers.length });

      const resolvedSupervisor = await this.resolveSupervisorContext('general');
      const supervisorBasePrompt = [
        resolvedSupervisor?.agent.system_prompt,
        settings.systemPrompt,
      ].filter((value): value is string => Boolean(value && value.trim())).join('\n\n');
      const supervisorInstructions = await this.buildSupervisorInstructions(supervisorBasePrompt, forceWorkerDataAnalysis, dbWorkerRows);
      const supervisorAdditionalTools = (await buildSupervisorAdditionalTools(resolvedSupervisor, toolOptions)) ?? tools;
      systemPromptSha256 = computePromptFingerprint(supervisorInstructions);

      agent = weaveAgent({
        model,
        workers: allWorkers,
        maxSteps: limits.chat_max_steps,
        name: resolvedSupervisor?.agent.name ?? 'geneweave-supervisor',
        systemPrompt: supervisorInstructions,
        defaultTimezone: resolvedSupervisor?.agent.default_timezone ?? settings.timezone,
        includeUtilityTools: resolvedSupervisor ? resolvedSupervisor.agent.include_utility_tools !== 0 : true,
        additionalTools: supervisorAdditionalTools,
        bus: agentBus,
        replanOnFailure: settings.supervisorReplanOnFailure,
        parallelDelegation: settings.supervisorParallelDelegation,
        ...(settings.reflectEnabled && {
          reflect: {
            maxRevisions: settings.reflectMaxRevisions,
            criteria: settings.reflectCriteria,
          },
        }),
      });
    } else {
      const policyPrompt = await this.withResponseCardFormatPolicy(applyTemporalToolPolicy({
        basePrompt: settings.systemPrompt,
        toolNames: settings.enabledTools,
        temporalToolPolicy: TEMPORAL_TOOL_POLICY,
      }));
      systemPromptSha256 = computePromptFingerprint(policyPrompt);
      if (settings.mode === 'ensemble' && settings.ensembleAgents?.length) {
        const ensembleAgents = await Promise.all(
          settings.ensembleAgents.map(async (def) => {
            const agentModel = def.model
              ? await getOrCreateModel(
                  this.config.defaultProvider,
                  def.model,
                  this.config.providers[this.config.defaultProvider] ?? {},
                )
              : model;
            return weaveAgent({
              model: agentModel,
              tools,
              systemPrompt: def.systemPrompt ?? policyPrompt,
              maxSteps: limits.chat_max_steps,
              name: def.name,
              bus: agentBus,
            });
          }),
        );
        const resolver = settings.ensembleResolver === 'arbiter'
          ? createArbiterResolver({ model })
          : createVoteResolver();
        agent = weaveEnsemble({ agents: ensembleAgents, resolver, parallel: true }) as unknown as Agent;
      } else {
        agent = weaveAgent({
          model,
          tools,
          systemPrompt: policyPrompt,
          maxSteps: limits.chat_max_steps,
          name: 'geneweave-agent',
          bus: agentBus,
          ...(settings.reflectEnabled && {
            reflect: {
              maxRevisions: settings.reflectMaxRevisions,
              criteria: settings.reflectCriteria,
            },
          }),
        });
      }
    }

    return { agent, systemPromptSha256, routedGoal, forceWorkerDataAnalysis, skillExecutionContracts };
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
    tenantId?: string | null,
  ): Promise<AgentRunTelemetry> {
    const limits = await resolveLimits(this.db, tenantId);
    const enterpriseToolGroups = await loadEnterpriseToolGroups(this.db);
    const hasEnterprise = enterpriseToolGroups.length > 0;
    const [disabledToolKeys, catalogEntries] = await Promise.all([
      this.getDisabledBuiltinToolKeys(),
      this.db.listEnabledToolCatalog(),
    ]);
    // Flat enterprise tools for backward compat (base tools only, no extended)
    const enterpriseTools = hasEnterprise ? await loadEnterpriseTools(this.db) : [];
    const toolOptions = this.buildAgentToolOptions(ctx, userId, chatId, userPersona, settings, attachments, disabledToolKeys, catalogEntries);
    const customTools = enterpriseTools.length > 0 ? enterpriseTools : undefined;
    const tools = settings.enabledTools.length
      ? await createToolRegistry(settings.enabledTools, customTools, toolOptions)
      : customTools?.length ? await createToolRegistry([], customTools, toolOptions) : undefined;

    const agentBus = weaveEventBus();
    const toolCallObserver = observeToolCallEvents(agentBus);

    try {
      // H-12: delegate shared agent construction to buildAgentInstance().
      const { agent, systemPromptSha256, routedGoal, forceWorkerDataAnalysis, skillExecutionContracts } =
        await this.buildAgentInstance({
          ctx, model, userContent, settings, attachments, limits, tools, customTools,
          enterpriseToolGroups, toolOptions, agentBus, hasEnterprise,
        });

      const result = await this.runWithCseSuccessGuard(
        agent,
        ctx,
        messages,
        routedGoal,
        forceWorkerDataAnalysis,
        skillExecutionContracts,
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
    tenantId?: string | null,
  ): Promise<AgentRunTelemetry> {
    const limits = await resolveLimits(this.db, tenantId);
    const enterpriseToolGroups = await loadEnterpriseToolGroups(this.db);
    const hasEnterprise = enterpriseToolGroups.length > 0;
    const enterpriseTools = hasEnterprise ? await loadEnterpriseTools(this.db) : [];
    const [disabledToolKeys, catalogEntries] = await Promise.all([
      this.getDisabledBuiltinToolKeys(),
      this.db.listEnabledToolCatalog(),
    ]);
    const toolOptions = this.buildAgentToolOptions(ctx, userId, chatId, userPersona, settings, attachments, disabledToolKeys, catalogEntries);
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
      // H-12: delegate shared agent construction to buildAgentInstance().
      const { agent, systemPromptSha256, routedGoal, forceWorkerDataAnalysis, skillExecutionContracts: skillExecutionContractsStream } =
        await this.buildAgentInstance({
          ctx, model, userContent, settings, attachments, limits, tools, customTools,
          enterpriseToolGroups, toolOptions, agentBus, hasEnterprise,
        });

    if (forceWorkerDataAnalysis) {
      const guarded = await this.runWithCseSuccessGuard(agent, ctx, messages, routedGoal, true, skillExecutionContractsStream);
      await this.writeSseEvent(res, { type: 'text', text: guarded.output });
      for (const step of guarded.steps) {
        await this.writeSseEvent(res, {
          type: 'step',
          step: { index: step.index, type: step.type, content: step.content, toolCall: step.toolCall, delegation: step.delegation, durationMs: step.durationMs },
          phase: 'step_end',
        });
      }
      return { result: guarded, toolCallEvents: toolCallObserver.events, systemPromptSha256 };
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
      // Stream ended without a 'done' event — log and fall through to the
      // non-streaming path rather than silently returning undefined output.
      log.warn('stream agent ended without done event, falling back to agent.run()');
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
      anthropic: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
      openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3', 'o4-mini'],
      google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash'],
      gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash'],
      ollama: ['llama3.1', 'llama3', 'qwen2.5', 'qwen3', 'mistral', 'phi3', 'gemma2', 'deepseek-r1', 'llava'],
      llamacpp: ['local'],
      'llama-cpp': ['local'],
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
   * When errorMessage indicates a rate limit (429), immediately marks the
   * provider unavailable so the next request routes away from it.
   */
  recordModelOutcome(modelId: string, providerId: string, latencyMs: number, success: boolean, errorMessage?: string): void {
    this.healthTracker.recordOutcome(modelId, providerId, latencyMs, success);

    if (!success && errorMessage && isRateLimitError(errorMessage)) {
      this.healthTracker.blockProvider(providerId, 5 * 60_000);
      return;
    }

    // Phase 3: latency-percentile degradation detection.
    // Trip a short soft block when a successful call takes ≥ P99×3 AND exceeds
    // the minimum threshold. This catches a provider that is still responding
    // but severely degraded, routing traffic away before users hit full timeouts.
    // (Industry standard: P99 × 3 multiplier, 30-second soft block.)
    if (success && latencyMs >= MIN_DEGRADATION_LATENCY_MS) {
      const endpointId = `${providerId}:rest`;
      const p99 = getP99Latency(endpointId);
      if (p99 !== undefined && latencyMs > p99 * DEGRADATION_MULTIPLIER) {
        log.warn('provider_degraded', {
          providerId,
          modelId,
          latencyMs,
          p99,
          threshold: p99 * DEGRADATION_MULTIPLIER,
          blockMs: DEGRADATION_BLOCK_MS,
        });
        this.healthTracker.blockProvider(providerId, DEGRADATION_BLOCK_MS);
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function isRateLimitError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes('rate limit') || lower.includes('rate_limit') ||
         lower.includes('quota') || lower.includes('too many requests') ||
         lower.includes('429');
}

