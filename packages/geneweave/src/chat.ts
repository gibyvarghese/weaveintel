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
 */

import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type {
  Model, ModelRequest, ModelResponse, StreamChunk, ExecutionContext, Message,
  ToolRegistry, AgentStepEvent, AgentStep, AgentResult,
  Guardrail, GuardrailResult, GuardrailStage,
} from '@weaveintel/core';
import { weaveContext, weaveEventBus } from '@weaveintel/core';
import { weaveAgent, weaveSupervisor } from '@weaveintel/agents';
import { weaveInMemoryTracer, weaveUsageTracker } from '@weaveintel/observability';
import { weaveRedactor } from '@weaveintel/redaction';
import { weaveEvalRunner } from '@weaveintel/evals';
import { createGuardrailPipeline, hasDeny, hasWarning, getDenyReason } from '@weaveintel/guardrails';
import type { DatabaseAdapter, MessageRow, ChatSettingsRow, GuardrailRow, HumanTaskPolicyRow, PromptRow, RoutingPolicyRow } from './db.js';
import { createToolRegistry } from './tools.js';
import { PolicyEvaluator, createPolicy } from '@weaveintel/human-tasks';
import { createTemplate } from '@weaveintel/prompts';
import { SmartModelRouter, ModelHealthTracker } from '@weaveintel/routing';
import type { ModelCostInfo, ModelQualityInfo } from '@weaveintel/routing';
import { weaveInMemoryCacheStore } from '@weaveintel/cache';
import { weaveCacheKeyBuilder } from '@weaveintel/cache';
import { shouldBypass, resolvePolicy } from '@weaveintel/cache';
import type { CachePolicy } from '@weaveintel/core';

// ─── Model pricing (per 1 M tokens) ─────────────────────────

interface ModelPricing { input: number; output: number }

const PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-20250514':       { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514':         { input: 15.00, output: 75.00 },
  'claude-haiku-4-20250414':        { input: 1.00, output: 5.00 },
  'gpt-4o':                         { input: 2.50, output: 10.00 },
  'gpt-4o-mini':                    { input: 0.15, output: 0.60 },
  'gpt-4.1':                        { input: 2.00, output: 8.00 },
  'gpt-4.1-mini':                   { input: 0.40, output: 1.60 },
  'gpt-4.1-nano':                   { input: 0.10, output: 0.40 },
  'o3':                             { input: 2.00, output: 8.00 },
  'o4-mini':                        { input: 1.10, output: 4.40 },
};

export function calculateCost(modelId: string, promptTokens: number, completionTokens: number): number {
  const pricing = PRICING[modelId];
  if (!pricing) return 0;
  return (promptTokens / 1_000_000) * pricing.input + (completionTokens / 1_000_000) * pricing.output;
}

// ─── Provider config ─────────────────────────────────────────

export interface ProviderConfig {
  apiKey: string;
}

export interface ChatEngineConfig {
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
  defaultModel: string;
}

// ─── Model factory ───────────────────────────────────────────

const modelCache = new Map<string, Model>();

export async function getOrCreateModel(
  provider: string,
  modelId: string,
  apiKey: string,
): Promise<Model> {
  const cacheKey = `${provider}:${modelId}`;
  const cached = modelCache.get(cacheKey);
  if (cached) return cached;

  let model: Model;
  switch (provider) {
    case 'anthropic': {
      const mod = await import('@weaveintel/provider-anthropic');
      model = (mod as any).weaveAnthropicModel(modelId, { apiKey });
      break;
    }
    case 'openai': {
      const mod = await import('@weaveintel/provider-openai');
      model = (mod as any).weaveOpenAIModel(modelId, { apiKey });
      break;
    }
    default:
      throw new Error(`Unsupported provider "${provider}". Install @weaveintel/provider-${provider}`);
  }

  modelCache.set(cacheKey, model);
  return model;
}

// ─── Chat engine ─────────────────────────────────────────────

export interface ChatSettings {
  mode: 'direct' | 'agent' | 'supervisor';
  systemPrompt?: string;
  enabledTools: string[];
  redactionEnabled: boolean;
  redactionPatterns: string[];
  workers: WorkerDef[];
}

export interface WorkerDef {
  name: string;
  description: string;
  tools: string[];
}

const DEFAULT_SETTINGS: ChatSettings = {
  mode: 'direct',
  enabledTools: [],
  redactionEnabled: false,
  redactionPatterns: ['email', 'phone', 'ssn', 'credit_card'],
  workers: [],
};

export function settingsFromRow(row: ChatSettingsRow | null): ChatSettings {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    mode: (row.mode as ChatSettings['mode']) || 'direct',
    systemPrompt: row.system_prompt ?? undefined,
    enabledTools: row.enabled_tools ? JSON.parse(row.enabled_tools) : [],
    redactionEnabled: !!row.redaction_enabled,
    redactionPatterns: row.redaction_patterns ? JSON.parse(row.redaction_patterns) : DEFAULT_SETTINGS.redactionPatterns,
    workers: row.workers ? JSON.parse(row.workers) : [],
  };
}

export class ChatEngine {
  private readonly healthTracker = new ModelHealthTracker();
  private readonly responseCache = weaveInMemoryCacheStore();
  private readonly cacheKeyBuilder = weaveCacheKeyBuilder({ namespace: 'gw-chat' });

  constructor(
    private readonly config: ChatEngineConfig,
    private readonly db: DatabaseAdapter,
  ) {}

  // ── Direct mode: send ───────────────────────────────────────

  async sendMessage(
    userId: string,
    chatId: string,
    content: string,
    opts?: { provider?: string; model?: string; maxTokens?: number; temperature?: number },
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
    policyChecks?: Array<{ tool: string; policy: string; taskType: string; priority: string }>;
    routingDecision?: { provider: string; model: string; reason: string };
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
    const settings = settingsFromRow(await this.db.getChatSettings(chatId));
    const resolvedPrompt = await this.resolveSystemPrompt(settings);
    const traceId = randomUUID();
    const ctx = weaveContext({ userId, deadline: Date.now() + 120_000, metadata: { traceId, chatId } });
    const startMs = Date.now();

    // Redaction
    let processedContent = content;
    let redactionInfo: { count: number; types: string[] } | undefined;
    if (settings.redactionEnabled) {
      const rd = await this.applyRedaction(ctx, content, settings.redactionPatterns);
      processedContent = rd.redacted;
      if (rd.wasModified) {
        redactionInfo = { count: rd.detections.length, types: [...new Set(rd.detections.map((d: any) => d.type))] };
      }
    }

    // Save user message
    const userMsgId = randomUUID();
    await this.db.addMessage({ id: userMsgId, chatId, role: 'user', content, metadata: redactionInfo ? JSON.stringify({ redaction: redactionInfo }) : undefined });

    // Pre-execution guardrails
    const preGuardrail = await this.evaluateGuardrails(chatId, userMsgId, processedContent, 'pre-execution');
    if (preGuardrail.decision === 'deny') {
      const denyContent = preGuardrail.reason || 'Your message was blocked by a guardrail policy.';
      const assistMsgId = randomUUID();
      await this.db.addMessage({ id: assistMsgId, chatId, role: 'assistant', content: denyContent, metadata: JSON.stringify({ guardrail: { decision: 'deny', reason: preGuardrail.reason } }) });
      return { assistantContent: denyContent, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, cost: 0, latencyMs: Date.now() - startMs, redaction: redactionInfo, guardrail: { decision: 'deny', reason: preGuardrail.reason } };
    }

    // Build conversation
    const history = await this.db.getMessages(chatId);
    const messages = historyToMessages(history);

    let assistantContent: string = '';
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let steps: AgentStep[] | undefined;
    let cacheHit = false;

    // ── Cache lookup ──
    const cachePolicy = await this.resolveActiveCache(settings.mode);
    const cacheKey = this.cacheKeyBuilder.build({ model: modelId, prompt: processedContent });
    if (cachePolicy && !shouldBypass(cachePolicy, processedContent)) {
      const cached = this.responseCache.get(cacheKey);
      if (cached) {
        assistantContent = (cached as any).content;
        usage = (cached as any).usage ?? usage;
        cacheHit = true;
      }
    }

    if (!cacheHit) {
    if (settings.mode === 'agent' || settings.mode === 'supervisor') {
      // ── Agent / Supervisor mode ──
      const result = await this.runAgent(ctx, model, messages, processedContent, settings);
      assistantContent = result.output;
      usage = {
        promptTokens: result.usage.totalTokens,  // agent tracks totalTokens only
        completionTokens: 0,
        totalTokens: result.usage.totalTokens,
      };
      steps = [...result.steps];
    } else {
      // ── Direct mode ──
      const request: ModelRequest = {
        messages: resolvedPrompt
          ? [{ role: 'system', content: resolvedPrompt }, ...messages]
          : messages,
        maxTokens: opts?.maxTokens ?? 4096,
        temperature: opts?.temperature,
      };
      const response = await model.generate(ctx, request);
      assistantContent = response.content;
      usage = { ...response.usage };
    }
    } // end if (!cacheHit)

    // ── Cache store ──
    if (!cacheHit && cachePolicy) {
      this.responseCache.set(cacheKey, { content: assistantContent!, usage }, cachePolicy.ttlMs);
    }

    const latencyMs = Date.now() - startMs;
    const cost = calculateCost(modelId, usage.promptTokens, usage.completionTokens);

    // Record health outcome
    this.recordModelOutcome(modelId, provider, latencyMs, true);

    // Human-task policy checks on tool calls
    const policyChecks = steps ? await this.evaluateTaskPolicies(steps) : undefined;

    // Eval
    let evalInfo: { passed: number; failed: number; total: number; score: number } | undefined;
    evalInfo = await this.runPostEval(ctx, userId, chatId, processedContent, assistantContent, latencyMs, cost);

    // Post-execution guardrails
    const postGuardrail = await this.evaluateGuardrails(chatId, null, assistantContent, 'post-execution');
    const guardrailInfo = preGuardrail.decision !== 'allow'
      ? { decision: preGuardrail.decision as 'allow' | 'deny' | 'warn', reason: preGuardrail.reason }
      : postGuardrail.decision !== 'allow'
      ? { decision: postGuardrail.decision as 'allow' | 'deny' | 'warn', reason: postGuardrail.reason }
      : undefined;

    // Save assistant message
    const assistMsgId = randomUUID();
    await this.db.addMessage({
      id: assistMsgId,
      chatId,
      role: 'assistant',
      content: assistantContent,
      metadata: JSON.stringify({
        model: modelId, provider,
        mode: settings.mode,
        agentName: settings.mode === 'supervisor' ? 'geneweave-supervisor' : settings.mode === 'agent' ? 'geneweave-agent' : undefined,
        systemPrompt: settings.systemPrompt || undefined,
        enabledTools: settings.enabledTools.length ? settings.enabledTools : undefined,
        redactionEnabled: settings.redactionEnabled || undefined,
        steps: steps ? steps.map(s => ({ type: s.type, content: s.content, toolCall: s.toolCall, delegation: s.delegation, durationMs: s.durationMs })) : undefined,
        eval: evalInfo,
        policyChecks: policyChecks?.length ? policyChecks : undefined,
        traceId,
      }),
      tokensUsed: usage.totalTokens,
      cost,
      latencyMs,
    });

    // Record metric
    await this.db.recordMetric({
      id: randomUUID(), userId, chatId, type: 'generation', provider, model: modelId,
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens, cost, latencyMs,
    });

    // Record traces
    await this.recordTraceSpans(userId, chatId, assistMsgId, traceId, settings.mode, startMs, latencyMs, steps);

    return { assistantContent, usage, cost, latencyMs, redaction: redactionInfo, eval: evalInfo, steps, traceId, guardrail: guardrailInfo, policyChecks, routingDecision: routingInfo };
  }

  // ── Stream mode ─────────────────────────────────────────────

  async streamMessage(
    res: ServerResponse,
    userId: string,
    chatId: string,
    content: string,
    opts?: { provider?: string; model?: string; maxTokens?: number; temperature?: number },
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
    const settings = settingsFromRow(await this.db.getChatSettings(chatId));
    const resolvedPrompt = await this.resolveSystemPrompt(settings);
    const traceId = randomUUID();
    const ctx = weaveContext({ userId, deadline: Date.now() + 120_000, metadata: { traceId, chatId } });

    // Redaction
    let processedContent = content;
    let redactionInfo: { count: number; types: string[] } | undefined;
    if (settings.redactionEnabled) {
      const rd = await this.applyRedaction(ctx, content, settings.redactionPatterns);
      processedContent = rd.redacted;
      if (rd.wasModified) {
        redactionInfo = { count: rd.detections.length, types: [...new Set(rd.detections.map((d: any) => d.type))] };
      }
    }

    // Save user message
    const userMsgId = randomUUID();
    await this.db.addMessage({ id: userMsgId, chatId, role: 'user', content, metadata: redactionInfo ? JSON.stringify({ redaction: redactionInfo }) : undefined });

    // Pre-execution guardrails
    const preGuardrail = await this.evaluateGuardrails(chatId, userMsgId, processedContent, 'pre-execution');
    if (preGuardrail.decision === 'deny') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const denyContent = preGuardrail.reason || 'Your message was blocked by a guardrail policy.';
      res.write(`data: ${JSON.stringify({ type: 'text', text: denyContent })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'guardrail', decision: 'deny', reason: preGuardrail.reason })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, cost: 0, latencyMs: 0 })}\n\n`);
      res.end();
      await this.db.addMessage({ id: randomUUID(), chatId, role: 'assistant', content: denyContent, metadata: JSON.stringify({ guardrail: { decision: 'deny', reason: preGuardrail.reason } }) });
      return;
    }

    // Build conversation
    const history = await this.db.getMessages(chatId);
    const messages = historyToMessages(history);

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

    try {
      if (settings.mode === 'agent' || settings.mode === 'supervisor') {
        // ── Agent / Supervisor streaming ──
        const agentResult = await this.streamAgent(res, ctx, model, messages, processedContent, settings);
        fullText = agentResult.output;
        finalUsage = { promptTokens: agentResult.usage.totalTokens, completionTokens: 0, totalTokens: agentResult.usage.totalTokens };
        steps = [...agentResult.steps];
      } else {
        // ── Direct streaming ──
        const request: ModelRequest = {
          messages: resolvedPrompt
            ? [{ role: 'system', content: resolvedPrompt }, ...messages]
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
    const cost = calculateCost(modelId, finalUsage.promptTokens, finalUsage.completionTokens);

    // Record health outcome
    this.recordModelOutcome(modelId, provider, latencyMs, true);

    // Human-task policy checks on tool calls
    const policyChecks = steps.length ? await this.evaluateTaskPolicies(steps) : undefined;
    if (policyChecks?.length) {
      res.write(`data: ${JSON.stringify({ type: 'policy_checks', checks: policyChecks })}\n\n`);
    }

    // Eval
    const evalInfo = await this.runPostEval(ctx, userId, chatId, processedContent, fullText, latencyMs, cost);
    if (evalInfo) {
      res.write(`data: ${JSON.stringify({ type: 'eval', ...evalInfo })}\n\n`);
    }

    // Post-execution guardrails
    const postGuardrail = await this.evaluateGuardrails(chatId, null, fullText, 'post-execution');
    if (postGuardrail.decision !== 'allow') {
      res.write(`data: ${JSON.stringify({ type: 'guardrail', decision: postGuardrail.decision, reason: postGuardrail.reason })}\n\n`);
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
      steps: steps.map(s => ({ type: s.type, content: s.content, toolCall: s.toolCall, delegation: s.delegation, durationMs: s.durationMs })),
      traceId,
    })}\n\n`);
    res.end();

    // Persist (fire-and-forget)
    const assistMsgId = randomUUID();
    await this.db.addMessage({
      id: assistMsgId, chatId, role: 'assistant', content: fullText,
      metadata: JSON.stringify({
        model: modelId, provider, streamed: true, mode: settings.mode,
        agentName: settings.mode === 'supervisor' ? 'geneweave-supervisor' : settings.mode === 'agent' ? 'geneweave-agent' : undefined,
        systemPrompt: settings.systemPrompt || undefined,
        enabledTools: settings.enabledTools.length ? settings.enabledTools : undefined,
        redactionEnabled: settings.redactionEnabled || undefined,
        steps: steps.length ? steps.map(s => ({ type: s.type, content: s.content, toolCall: s.toolCall, delegation: s.delegation, durationMs: s.durationMs })) : undefined,
        eval: evalInfo, policyChecks: policyChecks?.length ? policyChecks : undefined, traceId,
      }),
      tokensUsed: finalUsage.totalTokens, cost, latencyMs,
    });

    await this.db.recordMetric({
      id: randomUUID(), userId, chatId, type: 'generation', provider, model: modelId,
      promptTokens: finalUsage.promptTokens, completionTokens: finalUsage.completionTokens,
      totalTokens: finalUsage.totalTokens, cost, latencyMs,
    });

    await this.recordTraceSpans(userId, chatId, assistMsgId, traceId, settings.mode, startMs, latencyMs, steps);
  }

  // ── Agent execution (non-streaming) ─────────────────────────

  private async runAgent(
    ctx: ExecutionContext,
    model: Model,
    messages: Message[],
    userContent: string,
    settings: ChatSettings,
  ): Promise<AgentResult> {
    const tools = settings.enabledTools.length ? createToolRegistry(settings.enabledTools) : undefined;

    if (settings.mode === 'supervisor') {
      const workerDefs = settings.workers.length > 0
        ? settings.workers.map((w) => ({
            name: w.name,
            description: w.description,
            model,
            tools: w.tools.length ? createToolRegistry(w.tools) : undefined,
          }))
        : defaultWorkers(model);
      const supervisor = weaveSupervisor({ model, workers: workerDefs, maxSteps: 20, name: 'geneweave-supervisor' });
      return supervisor.run(ctx, { messages, goal: userContent });
    }

    const agent = weaveAgent({
      model,
      tools,
      systemPrompt: settings.systemPrompt,
      maxSteps: 15,
      name: 'geneweave-agent',
    });
    return agent.run(ctx, { messages, goal: userContent });
  }

  // ── Agent streaming ─────────────────────────────────────────

  private async streamAgent(
    res: ServerResponse,
    ctx: ExecutionContext,
    model: Model,
    messages: Message[],
    userContent: string,
    settings: ChatSettings,
  ): Promise<AgentResult> {
    const tools = settings.enabledTools.length ? createToolRegistry(settings.enabledTools) : undefined;

    let agent;
    if (settings.mode === 'supervisor') {
      const workerDefs = settings.workers.length > 0
        ? settings.workers.map((w) => ({
            name: w.name,
            description: w.description,
            model,
            tools: w.tools.length ? createToolRegistry(w.tools) : undefined,
          }))
        : defaultWorkers(model);
      agent = weaveSupervisor({ model, workers: workerDefs, maxSteps: 20, name: 'geneweave-supervisor' });
    } else {
      agent = weaveAgent({
        model,
        tools,
        systemPrompt: settings.systemPrompt,
        maxSteps: 15,
        name: 'geneweave-agent',
      });
    }

    // Try streaming mode first
    if (agent.runStream) {
      const stream = agent.runStream(ctx, { messages, goal: userContent });
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

      if (finalResult) return finalResult;
    }

    // Fallback: non-streaming agent run, send result as single text event
    const result = await agent.run(ctx, { messages, goal: userContent });
    res.write(`data: ${JSON.stringify({ type: 'text', text: result.output })}\n\n`);

    // Send step summaries
    for (const step of result.steps) {
      res.write(`data: ${JSON.stringify({
        type: 'step',
        step: { index: step.index, type: step.type, content: step.content, toolCall: step.toolCall, delegation: step.delegation, durationMs: step.durationMs },
        phase: 'step_end',
      })}\n\n`);
    }

    return result;
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
  ): Promise<{ passed: number; failed: number; total: number; score: number } | undefined> {
    try {
      const runner = weaveEvalRunner({
        executor: async (_ctx, inp) => ({ output: inp['output'] as string }),
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
        ],
      }, [
        { id: 'msg', input: { output, latencyMs, costUsd: cost }, expected: {} },
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

  private async recordTraceSpans(
    userId: string,
    chatId: string,
    messageId: string,
    traceId: string,
    mode: string,
    startMs: number,
    latencyMs: number,
    steps?: AgentStep[],
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
        attributes: JSON.stringify({ mode }),
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
    } catch {
      // Trace recording is best-effort
    }
  }

  /** Available models based on configured providers */
  getAvailableModels(): Array<{ id: string; provider: string }> {
    const models: Array<{ id: string; provider: string }> = [];
    for (const provider of Object.keys(this.config.providers)) {
      if (provider === 'anthropic') {
        models.push(
          { id: 'claude-sonnet-4-20250514', provider },
          { id: 'claude-opus-4-20250514', provider },
          { id: 'claude-haiku-4-20250414', provider },
        );
      } else if (provider === 'openai') {
        models.push(
          { id: 'gpt-4o', provider },
          { id: 'gpt-4o-mini', provider },
          { id: 'gpt-4.1', provider },
          { id: 'gpt-4.1-mini', provider },
          { id: 'gpt-4.1-nano', provider },
          { id: 'o3', provider },
          { id: 'o4-mini', provider },
        );
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
  ): Promise<{ decision: 'allow' | 'deny' | 'warn'; reason?: string; results: GuardrailResult[] }> {
    try {
      const rows = await this.db.listGuardrails();
      const enabledRows = rows.filter(r => r.enabled);
      if (enabledRows.length === 0) return { decision: 'allow', results: [] };

      const guardrails: Guardrail[] = enabledRows.map(r => ({
        id: r.id,
        name: r.name,
        description: r.description ?? undefined,
        type: (r.type === 'content_filter' ? 'blocklist' : r.type === 'budget' ? 'custom' : r.type === 'redaction' ? 'regex' : r.type === 'factuality' ? 'custom' : r.type) as Guardrail['type'],
        stage: (r.stage === 'pre' ? 'pre-execution' : r.stage === 'post' ? 'post-execution' : r.stage === 'both' ? stage : r.stage) as GuardrailStage,
        enabled: !!r.enabled,
        config: r.config ? JSON.parse(r.config) : {},
        priority: r.priority,
      }));

      const pipeline = createGuardrailPipeline(guardrails, { shortCircuitOnDeny: true });
      const results = await pipeline.evaluate(input, stage);

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

      return { decision, reason, results };
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
  private async resolveSystemPrompt(settings: ChatSettings): Promise<string | undefined> {
    if (!settings.systemPrompt) return undefined;

    try {
      // Check if the system prompt references a DB prompt by name
      const rows = await this.db.listPrompts();
      const match = rows.find(
        r => r.enabled && (r.id === settings.systemPrompt || r.name === settings.systemPrompt),
      );
      if (match) {
        // Render the template (variables may be empty for simple prompts)
        const tpl = createTemplate({ id: match.id, name: match.name, template: match.template });
        const vars: Record<string, unknown> = {};
        // Parse variable names from the prompt; provide empty defaults for optional ones
        if (match.variables) {
          const varNames: string[] = JSON.parse(match.variables);
          for (const v of varNames) vars[v] = `[${v}]`;
        }
        return tpl.render(vars);
      }
    } catch {
      // Fall through to plain text
    }

    return settings.systemPrompt;
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
      const candidates = this.getAvailableModels().map(m => ({
        modelId: m.id,
        providerId: m.provider,
      }));

      if (candidates.length === 0) return null;

      // Cost data from PRICING table
      const costs: ModelCostInfo[] = candidates.map(c => {
        const p = PRICING[c.modelId];
        return {
          modelId: c.modelId,
          providerId: c.providerId,
          inputCostPer1M: p ? p.input : 10,
          outputCostPer1M: p ? p.output : 30,
        };
      });

      // Quality estimates (static for now — higher-tier models get higher scores)
      const qualityMap: Record<string, number> = {
        'claude-opus-4-20250514': 0.95, 'gpt-4o': 0.9, 'gpt-4.1': 0.9,
        'claude-sonnet-4-20250514': 0.85, 'o3': 0.85,
        'gpt-4o-mini': 0.75, 'gpt-4.1-mini': 0.75, 'o4-mini': 0.75,
        'claude-haiku-4-20250414': 0.7, 'gpt-4.1-nano': 0.6,
      };
      const qualities: ModelQualityInfo[] = candidates.map(c => ({
        modelId: c.modelId,
        providerId: c.providerId,
        qualityScore: qualityMap[c.modelId] ?? 0.7,
      }));

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

/** Default workers for supervisor mode when none are explicitly configured */
function defaultWorkers(model: Model): Array<{ name: string; description: string; model: Model; tools?: ToolRegistry }> {
  return [
    {
      name: 'researcher',
      description: 'Researches topics, searches the web, and gathers information. Good for fact-finding and exploration tasks.',
      model,
      tools: createToolRegistry(['web_search', 'text_analysis']),
    },
    {
      name: 'analyst',
      description: 'Analyzes data, performs calculations, formats JSON, and provides structured insights. Good for math, data processing, and formatting.',
      model,
      tools: createToolRegistry(['calculator', 'json_format', 'text_analysis']),
    },
    {
      name: 'writer',
      description: 'Writes, edits, and refines text. Good for drafting content, summarizing, and creative writing tasks.',
      model,
      tools: createToolRegistry(['text_analysis', 'datetime']),
    },
  ];
}

function historyToMessages(rows: MessageRow[]): Message[] {
  return rows.map((r) => ({
    role: r.role as Message['role'],
    content: r.content,
  }));
}
