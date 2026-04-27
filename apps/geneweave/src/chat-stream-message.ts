import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { ExecutionContext, Message, AgentStep, ModelRequest, ModelHealth } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import { applySkillsToPrompt } from '@weaveintel/skills';
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
  normalizeAttachments,
  patchLatestUserMessage,
} from './chat-attachment-utils.js';
import {
  validatePromptContractsAgainstDb,
  type PromptContractValidationReport,
} from './chat-prompt-contract-utils.js';
import { discoverSkillsForInput } from './chat-skills-utils.js';
import { applyRedaction, runPostEval } from './chat-eval-utils.js';
import { recordTraceSpans, type ToolCallObservableEvent, type AgentRunTelemetry } from './chat-trace-utils.js';
import { evaluateGuardrails, evaluateTaskPolicies } from './chat-guardrail-eval-utils.js';
import { resolveSystemPrompt, buildCapabilityTelemetrySnapshots } from './chat-system-prompt-utils.js';
import { routeModel } from './chat-routing-utils.js';
import {
  buildMemoryContext,
  resolveIdentityRecallFromMemory,
  saveToMemory,
} from './chat-memory-utils.js';

type StreamMessageDeps = {
  config: ChatEngineConfig;
  db: DatabaseAdapter;
  healthTracker: {
    listHealth: () => ModelHealth[];
  };
  getAvailableModels: () => Promise<Array<{ id: string; provider: string }>>;
  withResponseCardFormatPolicy: (basePrompt: string | undefined) => Promise<string | undefined>;
  streamAgent: (
    res: ServerResponse,
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
  writeSseEvent: (res: ServerResponse, payload: Record<string, unknown>) => Promise<boolean>;
  endSse: (res: ServerResponse) => void;
  loadPricing: () => Promise<Map<string, ModelPricing>>;
  recordModelOutcome: (modelId: string, providerId: string, latencyMs: number, success: boolean) => void;
  safeParseJson: (text: string) => unknown;
};

export async function streamMessageImpl(
  deps: StreamMessageDeps,
  res: ServerResponse,
  userId: string,
  chatId: string,
  content: string,
  opts?: { provider?: string; model?: string; maxTokens?: number; temperature?: number; attachments?: ChatAttachment[] },
): Promise<void> {
  let provider = opts?.provider ?? deps.config.defaultProvider;
  let modelId = opts?.model ?? deps.config.defaultModel;
  let providerCfg = deps.config.providers[provider];

  const routed = await routeModel(deps.db, await deps.getAvailableModels(), deps.healthTracker.listHealth(), opts);
  if (routed && deps.config.providers[routed.provider]) {
    provider = routed.provider;
    modelId = routed.modelId;
    providerCfg = deps.config.providers[provider];
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
  const abortController = new AbortController();
  let clientDisconnected = false;
  const onClientClose = () => {
    clientDisconnected = true;
    abortController.abort();
  };
  res.once('close', onClientClose);

  const ctx = weaveContext({
    userId,
    deadline: Date.now() + 120_000,
    signal: abortController.signal,
    metadata: { traceId, chatId },
  });

  const attachments = normalizeAttachments(opts?.attachments);
  const contentWithAttachments = composeUserInput(content, attachments);

  let processedContent = contentWithAttachments;
  let redactionInfo: { count: number; types: string[] } | undefined;
  if (settings.redactionEnabled) {
    const rd = await applyRedaction(ctx, contentWithAttachments, settings.redactionPatterns);
    if (rd.error) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const denyContent = 'Your message could not be processed safely because redaction failed before execution.';
      await deps.writeSseEvent(res, { type: 'text', text: denyContent });
      await deps.writeSseEvent(res, { type: 'guardrail', decision: 'deny', reason: denyContent, error: rd.error });
      await deps.writeSseEvent(res, { type: 'done', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, cost: 0, latencyMs: 0 });
      deps.endSse(res);
      await deps.db.addMessage({
        id: randomUUID(),
        chatId,
        role: 'assistant',
        content: denyContent,
        metadata: JSON.stringify({
          guardrail: { decision: 'deny', reason: denyContent },
          redaction: { error: rd.error },
          traceId,
        }),
      });
      return;
    }
    processedContent = rd.redacted;
    if (rd.wasModified) {
      redactionInfo = { count: rd.detections.length, types: [...new Set(rd.detections.map((d: any) => d.type))] };
    }
  }

  const streamSkillContext = await discoverSkillsForInput(deps.db, processedContent, model, ctx, settings.mode, (t) => deps.safeParseJson(t));
  const streamSkillPrompt = applySkillsToPrompt(
    resolvedPrompt,
    streamSkillContext.matches,
    settings.mode === 'direct' ? 'advisory' : 'tool_assisted',
  );
  const streamEnabledTools = Array.from(new Set([...settings.enabledTools, ...streamSkillContext.toolNames]));
  const streamSkillPolicyKey = streamSkillContext.matches[0]?.skill.toolPolicyKey;
  const streamSkillTools = streamEnabledTools.filter((tool) => !settings.enabledTools.includes(tool));
  const streamActiveSkills = streamSkillContext.matches.map((m) => ({
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
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const denyContent = preGuardrail.reason || 'Your message was blocked by a guardrail policy.';
    await deps.writeSseEvent(res, { type: 'text', text: denyContent });
    await deps.writeSseEvent(res, { type: 'guardrail', decision: 'deny', reason: preGuardrail.reason });
    if (preGuardrail.cognitive) {
      await deps.writeSseEvent(res, { type: 'cognitive', ...preGuardrail.cognitive });
    }
    await deps.writeSseEvent(res, { type: 'done', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, cost: 0, latencyMs: 0 });
    deps.endSse(res);
    await deps.db.addMessage({
      id: randomUUID(),
      chatId,
      role: 'assistant',
      content: denyContent,
      metadata: JSON.stringify({ guardrail: { decision: 'deny', reason: preGuardrail.reason }, cognitive: preGuardrail.cognitive }),
    });
    return;
  }

  const identityRecall = await resolveIdentityRecallFromMemory(deps.db, userId, processedContent);
  if (identityRecall) {
    const latencyMs = 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (redactionInfo) {
      await deps.writeSseEvent(res, { type: 'redaction', ...redactionInfo });
    }
    await deps.writeSseEvent(res, { type: 'text', text: identityRecall });
    await deps.writeSseEvent(res, {
      type: 'done',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      cost: 0,
      latencyMs,
      model: 'memory-recall',
      provider: 'local',
      mode: settings.mode,
    });

    await deps.db.addMessage({
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

    await deps.db.recordMetric({
      id: randomUUID(), userId, chatId, type: 'generation', provider: 'local', model: 'memory-recall',
      promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, latencyMs,
    });

    deps.endSse(res);
    return;
  }

  const history = await deps.db.getMessages(chatId);
  const messages = historyToMessages(history);
  patchLatestUserMessage(messages, processedContent);

  const streamMemoryContext = await buildMemoryContext(deps.db, ctx, model, userId, processedContent);
  const streamAugmentedPrompt = streamMemoryContext
    ? (streamSkillPrompt ? `${streamSkillPrompt}\n\n---\n${streamMemoryContext}` : streamMemoryContext)
    : streamSkillPrompt;
  const streamMemorySettings = {
    ...settings,
    enabledTools: streamEnabledTools,
    systemPrompt: streamAugmentedPrompt,
    skillPolicyKey: streamSkillPolicyKey,
    skillContributedTools: streamSkillTools,
  };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  if (redactionInfo) {
    await deps.writeSseEvent(res, { type: 'redaction', ...redactionInfo });
  }

  const startMs = Date.now();
  let fullText = '';
  let finalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let steps: AgentStep[] = [];
  let toolCallEvents: ToolCallObservableEvent[] = [];
  let streamContractInfo: PromptContractValidationReport | undefined;
  let streamErrored = false;
  let streamErrorMessage: string | undefined;

  try {
    if (settings.mode === 'agent' || settings.mode === 'supervisor') {
      const telemetry = await deps.streamAgent(res, ctx, model, userId, chatId, userPersona, messages, processedContent, streamMemorySettings, attachments);
      fullText = telemetry.result.output ?? '';
      finalUsage = { promptTokens: telemetry.result.usage.totalTokens, completionTokens: 0, totalTokens: telemetry.result.usage.totalTokens };
      steps = [...telemetry.result.steps];
      toolCallEvents = telemetry.toolCallEvents;
    } else {
      const request: ModelRequest = {
        messages: streamAugmentedPrompt
          ? [{ role: 'system' as const, content: streamAugmentedPrompt }, ...messages]
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
            const delivered = await deps.writeSseEvent(res, { type: 'text', text: chunk.text });
            if (!delivered) {
              clientDisconnected = true;
              abortController.abort();
              break;
            }
          } else if (chunk.type === 'reasoning' && chunk.reasoning) {
            const delivered = await deps.writeSseEvent(res, { type: 'reasoning', text: chunk.reasoning });
            if (!delivered) {
              clientDisconnected = true;
              abortController.abort();
              break;
            }
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
        await deps.writeSseEvent(res, { type: 'text', text: response.content });
      }
    }
  } catch (err: unknown) {
    streamErrored = true;
    streamErrorMessage = err instanceof Error ? err.message : 'Stream error';
    if (!clientDisconnected) {
      await deps.writeSseEvent(res, { type: 'error', error: streamErrorMessage });
    }
  }

  const latencyMs = Date.now() - startMs;
  const streamDbPricing = await deps.loadPricing();
  const cost = calculateCost(modelId, finalUsage.promptTokens, finalUsage.completionTokens, streamDbPricing.get(modelId));

  deps.recordModelOutcome(modelId, provider, latencyMs, !streamErrored && !clientDisconnected);

  if (clientDisconnected) {
    return;
  }

  if (streamErrored && !fullText.trim()) {
    await deps.writeSseEvent(res, {
      type: 'done',
      usage: finalUsage,
      cost,
      latencyMs,
      model: modelId,
      provider,
      mode: settings.mode,
      streamInterrupted: true,
      error: streamErrorMessage,
      traceId,
    });
    deps.endSse(res);
    return;
  }

  const policyChecks = steps.length ? await evaluateTaskPolicies(deps.db, steps) : undefined;
  if (policyChecks?.length) {
    await deps.writeSseEvent(res, { type: 'policy_checks', checks: policyChecks });
  }

  if (!fullText.trim()) {
    const hadExecutionActivity = steps.length > 0;
    fullText = hadExecutionActivity
      ? 'I completed execution steps but could not produce a final response text. Please retry this request; if this repeats, check the trace for this run.'
      : 'I could not produce a response text for this request. Please retry.';
    await deps.writeSseEvent(res, { type: 'text', text: fullText });
  }

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
  const postGuardrail = await evaluateGuardrails(deps.db, chatId, null, fullText, 'post-execution', {
    userInput: processedContent,
    assistantOutput: fullText,
    toolEvidence: streamToolEvidence,
  });
  if (postGuardrail.cognitive) {
    await deps.writeSseEvent(res, { type: 'cognitive', ...postGuardrail.cognitive });
  }
  if (postGuardrail.decision !== 'allow') {
    await deps.writeSseEvent(res, { type: 'guardrail', decision: postGuardrail.decision, reason: postGuardrail.reason });
  }

  const streamGuardrailDecision = postGuardrail.decision as 'allow' | 'warn' | 'deny';
  const evalResult = await runPostEval(deps.db, ctx, userId, chatId, processedContent, fullText, latencyMs, cost, streamGuardrailDecision);
  const evalInfo = 'error' in evalResult ? undefined : evalResult;
  const evalError = 'error' in evalResult ? evalResult.error : undefined;
  if (evalInfo) {
    await deps.writeSseEvent(res, { type: 'eval', ...evalInfo });
  } else if (evalError) {
    await deps.writeSseEvent(res, { type: 'eval_error', error: evalError });
  }

  streamContractInfo = await validatePromptContractsAgainstDb(fullText, deps.db);
  if (streamContractInfo) {
    await deps.writeSseEvent(res, { type: 'contracts', ...streamContractInfo });
  }

  await deps.writeSseEvent(res, {
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
    evalError,
    guardrailError: preGuardrail.error ?? postGuardrail.error,
    promptStrategy: resolvedSystemPrompt.strategy,
    promptResolution: resolvedSystemPrompt.resolution,
    streamInterrupted: streamErrored || undefined,
    traceId,
  });

  const assistMsgId = randomUUID();
  await deps.db.addMessage({
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
      evalError,
      guardrail: postGuardrail.decision !== 'allow' ? { decision: postGuardrail.decision, reason: postGuardrail.reason } : undefined,
      guardrailError: preGuardrail.error ?? postGuardrail.error,
      cognitive: postGuardrail.cognitive,
      policyChecks: policyChecks?.length ? policyChecks : undefined,
      promptContracts: streamContractInfo,
      promptStrategy: resolvedSystemPrompt.strategy,
      promptResolution: resolvedSystemPrompt.resolution,
      streamInterrupted: streamErrored || undefined,
      traceId,
    }),
    tokensUsed: finalUsage.totalTokens, cost, latencyMs,
  });

  try {
    await saveToMemory(deps.db, ctx, model, userId, chatId, processedContent, fullText);
  } catch {
    // Keep chat success path resilient when memory persistence fails.
  }

  await deps.db.recordMetric({
    id: randomUUID(), userId, chatId, type: 'generation', provider, model: modelId,
    promptTokens: finalUsage.promptTokens, completionTokens: finalUsage.completionTokens,
    totalTokens: finalUsage.totalTokens, cost, latencyMs,
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
      streamActiveSkills,
      streamMemorySettings.enabledTools,
    ),
  );

  deps.endSse(res);
}

function historyToMessages(rows: MessageRow[]): Message[] {
  return rows.map((r) => ({
    role: r.role as Message['role'],
    content: r.content,
  }));
}
