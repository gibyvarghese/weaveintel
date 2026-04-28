import { randomUUID } from 'node:crypto';
import type { ExecutionContext, Message, AgentStep, ModelRequest } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import type { GuardrailCategorySummary } from '@weaveintel/guardrails';
import { applySkillsToPrompt } from '@weaveintel/skills';
import { shouldBypass } from '@weaveintel/cache';
import { ModelHealthTracker } from '@weaveintel/routing';
import type { DatabaseAdapter, MessageRow } from './db.js';
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
import { applyRedaction, runPostEval } from './chat-eval-utils.js';
import { recordTraceSpans, type ToolCallObservableEvent, type AgentRunTelemetry } from './chat-trace-utils.js';
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
} from './chat-memory-utils.js';

export type CognitiveCheckSummary = GuardrailCategorySummary;

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
  healthTracker: ModelHealthTracker;
  responseCache: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown, ttlMs: number) => Promise<void>;
  };
  cacheKeyBuilder: { build: (input: { model: string; prompt: string }) => string };
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
  ) => Promise<AgentRunTelemetry>;
  loadPricing: () => Promise<Map<string, ModelPricing>>;
  recordModelOutcome: (modelId: string, providerId: string, latencyMs: number, success: boolean) => void;
  safeParseJson: (text: string) => unknown;
};

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

  const routed = await routeModel(deps.db, await deps.getAvailableModels(), deps.healthTracker.listHealth(), { ...opts, prompt: content });
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
  const settings = settingsFromRow(await deps.db.getChatSettings(chatId));
  const resolvedSystemPrompt = await resolveSystemPrompt(deps.db, settings);
  const resolvedPrompt = await deps.withResponseCardFormatPolicy(resolvedSystemPrompt.content);
  const traceId = randomUUID();
  const ctx = weaveContext({ userId, deadline: Date.now() + 120_000, metadata: { traceId, chatId } });
  const startMs = Date.now();

  const attachments = normalizeAttachments(opts?.attachments);
  const contentWithAttachments = composeUserInput(content, attachments);

  let processedContent = contentWithAttachments;
  let redactionInfo: { count: number; types: string[] } | undefined;
  if (settings.redactionEnabled) {
    const rd = await applyRedaction(ctx, contentWithAttachments, settings.redactionPatterns);
    if (rd.error) {
      const denyContent = 'Your message could not be processed safely because redaction failed before execution.';
      const assistMsgId = randomUUID();
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

  const userMsgId = randomUUID();
  const userMetadata = redactionInfo || attachments.length > 0
    ? JSON.stringify({
        redaction: redactionInfo,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
    : undefined;
  await deps.db.addMessage({ id: userMsgId, chatId, role: 'user', content, metadata: userMetadata });

  const preGuardrail = await evaluateGuardrails(deps.db, chatId, userMsgId, processedContent, 'pre-execution');
  if (preGuardrail.decision === 'deny') {
    const denyContent = preGuardrail.reason || 'Your message was blocked by a guardrail policy.';
    const assistMsgId = randomUUID();
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
    const assistMsgId = randomUUID();
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

    await deps.db.recordMetric({
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

  const history = await deps.db.getMessages(chatId);
  const messages = historyToMessages(history);
  patchLatestUserMessage(messages, processedContent);

  const memoryContext = await buildMemoryContext(deps.db, ctx, model, userId, processedContent);
  const augmentedPrompt = memoryContext
    ? (skillPrompt ? `${skillPrompt}\n\n---\n${memoryContext}` : memoryContext)
    : skillPrompt;
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
  const cacheKey = deps.cacheKeyBuilder.build({ model: modelId, prompt: processedContent });
  if (cachePolicy && !shouldBypass(cachePolicy, processedContent)) {
    const cached = await deps.responseCache.get(cacheKey);
    if (cached) {
      assistantContent = (cached as any).content ?? '';
      usage = (cached as any).usage ?? usage;
      cacheHit = true;
    }
  }

  if (!cacheHit) {
    if (settings.mode === 'agent' || settings.mode === 'supervisor') {
      telemetry = await deps.runAgent(ctx, model, userId, chatId, userPersona, messages, processedContent, memorySettings, attachments);
      assistantContent = telemetry.result.output ?? '';
      usage = {
        promptTokens: telemetry.result.usage.totalTokens,
        completionTokens: 0,
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
      const response = await model.generate(ctx, request);
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
  const postGuardrail = await evaluateGuardrails(deps.db, chatId, null, assistantContent, 'post-execution', {
    userInput: processedContent,
    assistantOutput: assistantContent,
    toolEvidence,
  });
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

  const assistMsgId = randomUUID();
  await deps.db.addMessage({
    id: assistMsgId,
    chatId,
    role: 'assistant',
    content: assistantContent,
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
    await saveToMemory(deps.db, ctx, model, userId, chatId, processedContent, assistantContent);
  } catch {
    // Keep chat success path resilient when memory persistence fails.
  }

  await deps.db.recordMetric({
    id: randomUUID(), userId, chatId, type: 'generation', provider, model: modelId,
    promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens, cost, latencyMs,
  });

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

function historyToMessages(rows: MessageRow[]): Message[] {
  return rows.map((r) => ({
    role: r.role as Message['role'],
    content: r.content,
  }));
}
