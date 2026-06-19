import { newUUIDv7, createLogger } from '@weaveintel/core';

const logger = createLogger('chat-send-message');
import type { ExecutionContext, Message, AgentStep, ModelRequest } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import type { GuardrailCategorySummary } from '@weaveintel/guardrails';
import { applySkillsToPrompt } from '@weaveintel/skills';
import { shouldBypass } from '@weaveintel/cache';
import type { RuntimeRoutingSlot } from '@weaveintel/core';
import type { DurableConsentManager } from '@weaveintel/compliance';
import type { DatabaseAdapter } from './db.js';
import { normalizePersona } from './rbac.js';
import {
  calculateCost,
  getOrCreateModel,
  settingsFromRow,
  type ChatAttachment,
  type ChatEngineConfig,
  type ChatSettings,
} from './chat-runtime.js';
import type { ModelPricing } from './chat-pricing-utils.js';
import {
  composeUserInput,
  hasTabularDataAttachments,
  normalizeAttachments,
  patchLatestUserMessage,
} from './chat-attachment-utils.js';
import {
  hasCodeExecutorDelegation,
  hasSuccessfulCseExecution,
} from './chat-cse-utils.js';
import { hasRenderableAttachmentAnalysisOutput } from './chat-output-guards.js';
import {
  validatePromptContractsAgainstDb,
  type PromptContractValidationReport,
} from './chat-prompt-contract-utils.js';
import { shouldForceWorkerDataAnalysis } from './chat-intent-utils.js';
import { discoverSkillsForInput } from './chat-skills-utils.js';
import { applyRedaction, runPostEval, SUPERVISOR_INTERNAL_TOOLS } from './chat-eval-utils.js';
import { historyToMessages, extractToolEvidence } from './chat-message-utils.js';
import { recordTraceSpans, withLLMSpan, type ToolCallObservableEvent, type AgentRunTelemetry } from './chat-trace-utils.js';
import { evaluateGuardrails, evaluateTaskPolicies } from './chat-guardrail-eval-utils.js';
import {
  resolveSystemPrompt,
  buildCapabilityTelemetrySnapshots,
  type PromptStrategyInfo,
} from './chat-system-prompt-utils.js';
import { routeModel, resolveActiveCache } from './chat-routing-utils.js';
import {
  buildMemoryContext,
  resolveIdentityRecallFromMemory,
  saveToMemory,
  loadProceduralInstructions,
  buildEpisodicContext,
  buildWorkingMemoryContext,
} from './chat-memory-utils.js';
import { triggerConsolidationForUser } from './memory-consolidation.js';

export type CognitiveCheckSummary = GuardrailCategorySummary;

/**
 * M-16: Shape of values written to / read from the response cache.
 * Defined explicitly so the cache hit path is type-checked instead of
 * using `as any`, which would silently accept a malformed cache entry.
 */
export interface CachedResponse {
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
}

export type SendMessageResult = {
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
};

export type SendMessageDeps = {
  config: ChatEngineConfig;
  db: DatabaseAdapter;
  healthTracker: RuntimeRoutingSlot;
  responseCache: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown, ttlMs: number) => Promise<void>;
  };
  cacheKeyBuilder: { build: (input: { model: string; prompt: string; userId?: string }) => string };
  getAvailableModels: () => Promise<Array<{ id: string; provider: string }>>;
  withResponseCardFormatPolicy: (basePrompt: string | undefined) => Promise<string | undefined>;
  runAgent: (
    ctx: ExecutionContext,
    model: any,
    userId: string,
    chatId: string,
    userPersona: string,
    messages: Message[],
    userContent: string,
    settings: ChatSettings,
    attachments?: ChatAttachment[],
    tenantId?: string | null,
  ) => Promise<AgentRunTelemetry>;
  loadPricing: () => Promise<Map<string, ModelPricing>>;
  recordModelOutcome: (modelId: string, providerId: string, latencyMs: number, success: boolean, errorMessage?: string) => void;
  safeParseJson: (text: string) => unknown;
  consentManager?: DurableConsentManager | null;
};

async function isAnalyticsAllowed(consentManager: DurableConsentManager | null | undefined, userId: string): Promise<boolean> {
  if (!consentManager) return true;
  try {
    const flags = await consentManager.listBySubject(userId);
    const flag = flags.find(f => f.purpose === 'analytics');
    if (!flag) return true;
    return consentManager.isGranted(userId, 'analytics');
  } catch { return true; }
}

export async function sendMessageImpl(
  deps: SendMessageDeps,
  userId: string,
  chatId: string,
  content: string,
  opts?: { provider?: string; model?: string; maxTokens?: number; temperature?: number; attachments?: ChatAttachment[] },
): Promise<SendMessageResult> {
  let provider = opts?.provider ?? deps.config.defaultProvider;
  let modelId = opts?.model ?? deps.config.defaultModel;
  let providerCfg = deps.config.providers[provider];
  let routingInfo: { provider: string; model: string; reason: string } | undefined;

  const routed = await routeModel(deps.db, await deps.getAvailableModels(), deps.healthTracker.listHealth(), { ...opts, prompt: content }, deps.healthTracker.getBlockedProviders());
  if (routed && deps.config.providers[routed.provider]) {
    provider = routed.provider;
    modelId = routed.modelId;
    providerCfg = deps.config.providers[provider];
    routingInfo = { provider, model: modelId, reason: 'Selected by routing policy' };
  }

  if (!providerCfg) {
    provider = deps.config.defaultProvider;
    modelId = deps.config.defaultModel;
    providerCfg = deps.config.providers[provider];
  }
  if (!providerCfg) {
    const first = Object.entries(deps.config.providers)[0];
    if (!first) throw new Error('No providers configured');
    [provider, providerCfg] = first;
    modelId = deps.config.defaultModel;
  }

  const model = await getOrCreateModel(provider, modelId, providerCfg);
  const actor = await deps.db.getUserById(userId);
  const userPersona = normalizePersona(actor?.persona, 'user');
  const tenantId = actor?.tenant_id ?? null;
  const settings = settingsFromRow(await deps.db.getChatSettings(chatId));
  const resolvedSystemPrompt = await resolveSystemPrompt(deps.db, settings);
  const resolvedPrompt = await deps.withResponseCardFormatPolicy(resolvedSystemPrompt.content);
  const traceId = newUUIDv7();
  const ctx = weaveContext({ runtime: deps.config.runtime, userId, deadline: Date.now() + 120_000, metadata: { traceId, chatId } });
  const startMs = Date.now();

  const attachments = normalizeAttachments(opts?.attachments);
  const contentWithAttachments = composeUserInput(content, attachments);

  let processedContent = contentWithAttachments;
  let redactionInfo: { count: number; types: string[] } | undefined;
  if (settings.redactionEnabled) {
    const rd = await applyRedaction(ctx, contentWithAttachments, settings.redactionPatterns);
    if (rd.error) {
      const denyContent = 'Your message could not be processed safely because redaction failed before execution.';
      const assistMsgId = newUUIDv7();
      await deps.db.addMessage({
        id: assistMsgId,
        chatId,
        role: 'assistant',
        content: denyContent,
        metadata: JSON.stringify({
          guardrail: { decision: 'deny', reason: denyContent },
          redaction: { error: rd.error },
          traceId,
        }),
      });
      return {
        assistantContent: denyContent,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        cost: 0,
        latencyMs: Date.now() - startMs,
        guardrail: { decision: 'deny', reason: denyContent },
      };
    }
    processedContent = rd.redacted;
    if (rd.wasModified) {
      redactionInfo = { count: rd.detections.length, types: [...new Set(rd.detections.map((d: any) => d.type))] };
    }
  }

  // Phase 0: pre-LLM input guardrail gate. Runs on the post-redaction content
  // so PII-stripped text is evaluated. Fail-open: a missing slot or thrown
  // check is treated as allow (guardrails are never load-bearing).
  if (deps.config.runtime?.guardrails?.checkInput) {
    try {
      const inputCheck = await deps.config.runtime.guardrails.checkInput(ctx, processedContent);
      if (!inputCheck.allow) {
        const denyContent = inputCheck.reason ?? 'Your message was blocked by a content guardrail.';
        const assistMsgId = newUUIDv7();
        await deps.db.addMessage({
          id: assistMsgId, chatId, role: 'assistant', content: denyContent,
          metadata: JSON.stringify({ guardrail: { decision: 'deny', reason: denyContent }, traceId }),
        });
        return {
          assistantContent: denyContent,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          cost: 0, latencyMs: Date.now() - startMs,
          guardrail: { decision: 'deny', reason: denyContent },
        };
      }
    } catch {
      // fail-open on check error
    }
  }

  const skillContext = await discoverSkillsForInput(
    deps.db,
    processedContent,
    model,
    ctx,
    settings.mode,
    (t) => deps.safeParseJson(t),
    { hasTabularAttachment: hasTabularDataAttachments(attachments) },
  );
  const skillPrompt = applySkillsToPrompt(
    resolvedPrompt,
    skillContext.matches,
    settings.mode === 'direct' ? 'advisory' : 'tool_assisted',
    processedContent,
  );
  const skillPolicyKey = skillContext.matches[0]?.skill.toolPolicyKey;

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

  const userMsgId = newUUIDv7();
  const userMetadata = redactionInfo || attachments.length > 0
    ? JSON.stringify({
        redaction: redactionInfo,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
    : undefined;
  // CR-1: Always persist the post-redaction form of the message so PII that was
  // scrubbed from `processedContent` is never written to the messages table.
  // `content` (the raw input) is used only for in-memory processing above this
  // point and must not reach the database when redaction is enabled.
  await deps.db.addMessage({ id: userMsgId, chatId, role: 'user', content: processedContent, metadata: userMetadata });

  // Load history now so turn number is available for condition context.
  // (This is the same query made later for model context; moved up to avoid drift.)
  const history = await deps.db.getMessages(chatId);
  const turnNumber = Math.ceil(history.length / 2);

  const preGuardrail = await evaluateGuardrails(
    deps.db, chatId, userMsgId, processedContent, 'pre-execution',
    undefined,
    { persona: userPersona, chatMode: settings.mode, turnNumber, tenantId },
  );
  if (preGuardrail.decision === 'deny') {
    const denyContent = preGuardrail.reason || 'Your message was blocked by a guardrail policy.';
    const assistMsgId = newUUIDv7();
    await deps.db.addMessage({
      id: assistMsgId,
      chatId,
      role: 'assistant',
      content: denyContent,
      metadata: JSON.stringify({
        guardrail: { decision: 'deny', reason: preGuardrail.reason },
        cognitive: preGuardrail.cognitive,
      }),
    });
    // Episodic logging: always capture the turn even when guardrail blocks LLM processing.
    // Memory governance will redact any PII before the entry is persisted.
    try {
      await saveToMemory(deps.db, ctx, model, userId, chatId, processedContent, denyContent, tenantId ?? undefined);
    } catch { /* episodic capture is best-effort */ }
    return {
      assistantContent: denyContent,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      cost: 0,
      latencyMs: Date.now() - startMs,
      redaction: redactionInfo,
      guardrail: { decision: 'deny', reason: preGuardrail.reason },
      cognitive: preGuardrail.cognitive as CognitiveCheckSummary,
    };
  }

  const identityRecall = await resolveIdentityRecallFromMemory(deps.db, userId, processedContent);
  if (identityRecall) {
    const latencyMs = Date.now() - startMs;
    const assistMsgId = newUUIDv7();
    await deps.db.addMessage({
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

    if (await isAnalyticsAllowed(deps.consentManager, userId)) {
      await deps.db.recordMetric({
        id: newUUIDv7(), userId, chatId, type: 'generation', provider: 'local', model: 'memory-recall',
        promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, latencyMs,
      });
    }

    return {
      assistantContent: identityRecall,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      cost: 0,
      latencyMs,
      redaction: redactionInfo,
    };
  }

  const messages = historyToMessages(history);
  patchLatestUserMessage(messages, processedContent);

  const [memoryContext, proceduralInstructions, episodicContext, workingMemoryContext] = await Promise.all([
    buildMemoryContext(deps.db, ctx, model, userId, processedContent),
    loadProceduralInstructions(deps.db, userId),
    buildEpisodicContext(deps.db, userId, 6),
    buildWorkingMemoryContext(deps.db, userId),
  ]);
  const contextParts: string[] = [];
  if (skillPrompt) contextParts.push(skillPrompt);
  if (proceduralInstructions) contextParts.push(proceduralInstructions);
  if (workingMemoryContext) contextParts.push(workingMemoryContext);
  if (memoryContext) contextParts.push(memoryContext);
  if (episodicContext) contextParts.push(episodicContext);
  const augmentedPrompt = contextParts.length > 0 ? contextParts.join('\n\n---\n') : undefined;
  const memorySettings = {
    ...settings,
    enabledTools,
    systemPrompt: augmentedPrompt,
    skillPolicyKey,
    skillContributedTools: skillTools,
  };

  let assistantContent = '';
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let steps: AgentStep[] | undefined;
  let toolCallEvents: ToolCallObservableEvent[] | undefined;
  let cacheHit = false;
  let contractInfo: PromptContractValidationReport | undefined;
  let telemetry: AgentRunTelemetry | undefined;

  const allowResponseCache = attachments.length === 0;
  const cachePolicy = allowResponseCache ? await resolveActiveCache(deps.db, settings.mode) : null;
  // Include userId in the cache key so personalised answers (e.g. "what did I
  // say earlier?") are never served to a different user from the cache.
  const cacheKey = deps.cacheKeyBuilder.build({ model: modelId, prompt: processedContent, userId });
  if (cachePolicy && !shouldBypass(cachePolicy, processedContent)) {
    const cached = await deps.responseCache.get(cacheKey);
    if (cached) {
      // M-16: cast through CachedResponse so the fields are validated at
      // the type level. If the cache returns an unexpected shape the
      // fallback (empty string / zero usage) prevents a runtime crash.
      const cachedTyped = cached as CachedResponse;
      assistantContent = typeof cachedTyped.content === 'string' ? cachedTyped.content : '';
      usage = cachedTyped.usage ?? usage;
      cacheHit = true;
    }
  }

  if (!cacheHit) {
    if (settings.mode === 'agent' || settings.mode === 'supervisor') {
      telemetry = await deps.runAgent(ctx, model, userId, chatId, userPersona, messages, processedContent, memorySettings, attachments, tenantId);
      assistantContent = telemetry.result.output ?? '';
      // H-4: Propagate the true prompt/completion split from AgentResult.usage.
      // Previously both were set to totalTokens (i.e. completionTokens = 0),
      // which causes the cost dashboard to calculate cost using only the input
      // token rate and under-reports actual spend on agent/supervisor calls.
      usage = {
        promptTokens: telemetry.result.usage.promptTokens,
        completionTokens: telemetry.result.usage.completionTokens,
        totalTokens: telemetry.result.usage.totalTokens,
      };
      steps = [...telemetry.result.steps];
      toolCallEvents = telemetry.toolCallEvents;
    } else {
      const request: ModelRequest = {
        messages: augmentedPrompt
          ? [{ role: 'system' as const, content: augmentedPrompt }, ...messages]
          : messages,
        maxTokens: opts?.maxTokens ?? 4096,
        temperature: opts?.temperature,
      };
      // Phase 1: wrap in an OTel GenAI span so LLM calls are visible in
      // any OTLP-compatible backend (Grafana Cloud, Honeycomb, Jaeger).
      const { result: response } = await withLLMSpan(
        ctx,
        { provider, modelId, operation: 'chat', maxTokens: request.maxTokens, temperature: request.temperature },
        () => model.generate(ctx, request),
      );
      assistantContent = response.content ?? '';
      usage = { ...response.usage };
    }
  }

  if (!cacheHit && cachePolicy && !assistantContent.includes('[Execution guard failure]')) {
    await deps.responseCache.set(cacheKey, { content: assistantContent, usage }, cachePolicy.ttlMs);
  }

  contractInfo = await validatePromptContractsAgainstDb(assistantContent, deps.db);

  const latencyMs = Date.now() - startMs;
  const dbPricing = await deps.loadPricing();
  const cost = calculateCost(modelId, usage.promptTokens, usage.completionTokens, dbPricing.get(modelId));

  deps.recordModelOutcome(modelId, provider, latencyMs, true);

  const policyChecks = steps ? await evaluateTaskPolicies(deps.db, steps) : undefined;

  if (!assistantContent.trim()) {
    const hadExecutionActivity = Boolean(steps?.length);
    assistantContent = hadExecutionActivity
      ? 'I completed execution steps but could not produce a final response text. Please retry this request; if this repeats, check the trace for this run.'
      : 'I could not produce a response text for this request. Please retry.';
  }

  // M-18: extracted to chat-message-utils.extractToolEvidence — shared with stream path
  const toolEvidence = extractToolEvidence(steps);
  const postGuardrail = await evaluateGuardrails(deps.db, chatId, null, assistantContent, 'post-execution',
    { userInput: processedContent, assistantOutput: assistantContent, toolEvidence },
    {
      persona: userPersona,
      chatMode: settings.mode,
      turnNumber,
      tenantId,
      steps: steps ?? [],
      priorGuardrailResults: preGuardrail.results,
    },
  );
  const guardrailInfo = preGuardrail.decision !== 'allow'
    ? { decision: preGuardrail.decision as 'allow' | 'deny' | 'warn', reason: preGuardrail.reason }
    : postGuardrail.decision !== 'allow'
    ? { decision: postGuardrail.decision as 'allow' | 'deny' | 'warn', reason: postGuardrail.reason }
    : undefined;

  const overallGuardrailDecision = guardrailInfo?.decision ?? 'allow';
  let evalInfo: { passed: number; failed: number; total: number; score: number } | undefined;
  let evalError: string | undefined;
  const evalResult = await runPostEval(deps.db, ctx, userId, chatId, processedContent, assistantContent, latencyMs, cost, overallGuardrailDecision);
  if ('error' in evalResult) {
    evalError = evalResult.error;
  } else {
    evalInfo = evalResult;
  }

  const assistMsgId = newUUIDv7();
  await deps.db.addMessage({
    id: assistMsgId,
    chatId,
    role: 'assistant',
    content: assistantContent,
    metadata: JSON.stringify({
      model: modelId, provider,
      mode: settings.mode,
      agentName: settings.mode === 'supervisor' ? 'geneweave-supervisor' : settings.mode === 'agent' ? 'geneweave-agent' : undefined,
      systemPromptSha256: telemetry?.systemPromptSha256,
      enabledTools: memorySettings.enabledTools.length ? memorySettings.enabledTools : undefined,
      activeSkills: activeSkills.length ? activeSkills : undefined,
      skillTools: skillTools.length ? skillTools : undefined,
      skillPromptApplied: activeSkills.length > 0 ? true : undefined,
      redactionEnabled: settings.redactionEnabled || undefined,
      steps: steps ? steps.map(s => ({ type: s.type, content: s.content, toolCall: s.toolCall, delegation: s.delegation, durationMs: s.durationMs })) : undefined,
      eval: evalInfo,
      evalError,
      guardrail: guardrailInfo,
      guardrailError: preGuardrail.error ?? postGuardrail.error,
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

  try {
    await saveToMemory(deps.db, ctx, model, userId, chatId, processedContent, assistantContent, tenantId ?? undefined);
    triggerConsolidationForUser(userId, chatId);
  } catch (memErr) {
    // L-16: Log memory save / consolidation failures so operators can detect
    // memory backend outages without impacting the chat success path.
    logger.warn('memory save / consolidation failed', { err: memErr instanceof Error ? memErr.message : String(memErr) });
  }

  if (await isAnalyticsAllowed(deps.consentManager, userId)) {
    await deps.db.recordMetric({
      id: newUUIDv7(), userId, chatId, type: 'generation', provider, model: modelId,
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens, cost, latencyMs,
    });
  }

  await recordTraceSpans(
    deps.db,
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
    telemetry?.systemPromptSha256,
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
    cognitive: postGuardrail.cognitive as CognitiveCheckSummary,
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

// H-15: historyToMessages moved to chat-message-utils.ts — imported above
