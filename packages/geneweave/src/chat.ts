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
} from '@weaveintel/core';
import { weaveContext, weaveEventBus } from '@weaveintel/core';
import { weaveAgent, weaveSupervisor } from '@weaveintel/agents';
import { weaveInMemoryTracer, weaveUsageTracker } from '@weaveintel/observability';
import { weaveRedactor } from '@weaveintel/redaction';
import { weaveEvalRunner } from '@weaveintel/evals';
import type { DatabaseAdapter, MessageRow, ChatSettingsRow } from './db.js';
import { createToolRegistry } from './tools.js';

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
      model = (mod as any).weaveOpenAIModel({ apiKey, model: modelId });
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
  }> {
    const provider = opts?.provider ?? this.config.defaultProvider;
    const modelId = opts?.model ?? this.config.defaultModel;
    const providerCfg = this.config.providers[provider];
    if (!providerCfg) throw new Error(`Provider "${provider}" not configured`);

    const model = await getOrCreateModel(provider, modelId, providerCfg.apiKey);
    const settings = settingsFromRow(await this.db.getChatSettings(chatId));
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

    // Build conversation
    const history = await this.db.getMessages(chatId);
    const messages = historyToMessages(history);

    let assistantContent: string;
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let steps: AgentStep[] | undefined;

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
        messages: settings.systemPrompt
          ? [{ role: 'system', content: settings.systemPrompt }, ...messages]
          : messages,
        maxTokens: opts?.maxTokens ?? 4096,
        temperature: opts?.temperature,
      };
      const response = await model.generate(ctx, request);
      assistantContent = response.content;
      usage = { ...response.usage };
    }

    const latencyMs = Date.now() - startMs;
    const cost = calculateCost(modelId, usage.promptTokens, usage.completionTokens);

    // Eval
    let evalInfo: { passed: number; failed: number; total: number; score: number } | undefined;
    evalInfo = await this.runPostEval(ctx, userId, chatId, processedContent, assistantContent, latencyMs, cost);

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
        steps: steps ? steps.map(s => ({ type: s.type, content: s.content, toolCall: s.toolCall, delegation: s.delegation, durationMs: s.durationMs })) : undefined,
        eval: evalInfo,
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

    return { assistantContent, usage, cost, latencyMs, redaction: redactionInfo, eval: evalInfo, steps, traceId };
  }

  // ── Stream mode ─────────────────────────────────────────────

  async streamMessage(
    res: ServerResponse,
    userId: string,
    chatId: string,
    content: string,
    opts?: { provider?: string; model?: string; maxTokens?: number; temperature?: number },
  ): Promise<void> {
    const provider = opts?.provider ?? this.config.defaultProvider;
    const modelId = opts?.model ?? this.config.defaultModel;
    const providerCfg = this.config.providers[provider];
    if (!providerCfg) throw new Error(`Provider "${provider}" not configured`);

    const model = await getOrCreateModel(provider, modelId, providerCfg.apiKey);
    const settings = settingsFromRow(await this.db.getChatSettings(chatId));
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
    await this.db.addMessage({ id: randomUUID(), chatId, role: 'user', content, metadata: redactionInfo ? JSON.stringify({ redaction: redactionInfo }) : undefined });

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
          messages: settings.systemPrompt
            ? [{ role: 'system', content: settings.systemPrompt }, ...messages]
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

    // Eval
    const evalInfo = await this.runPostEval(ctx, userId, chatId, processedContent, fullText, latencyMs, cost);
    if (evalInfo) {
      res.write(`data: ${JSON.stringify({ type: 'eval', ...evalInfo })}\n\n`);
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
        steps: steps.length ? steps.map(s => ({ type: s.type, content: s.content, toolCall: s.toolCall, delegation: s.delegation, durationMs: s.durationMs })) : undefined,
        eval: evalInfo, traceId,
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

    if (settings.mode === 'supervisor' && settings.workers.length > 0) {
      const workers = settings.workers.map((w) => ({
        name: w.name,
        description: w.description,
        model,
        tools: w.tools.length ? createToolRegistry(w.tools) : undefined,
      }));
      const supervisor = weaveSupervisor({ model, workers, maxSteps: 20, name: 'geneweave-supervisor' });
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
    if (settings.mode === 'supervisor' && settings.workers.length > 0) {
      const workers = settings.workers.map((w) => ({
        name: w.name,
        description: w.description,
        model,
        tools: w.tools.length ? createToolRegistry(w.tools) : undefined,
      }));
      agent = weaveSupervisor({ model, workers, maxSteps: 20, name: 'geneweave-supervisor' });
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
}

// ─── Helpers ─────────────────────────────────────────────────

function historyToMessages(rows: MessageRow[]): Message[] {
  return rows.map((r) => ({
    role: r.role as Message['role'],
    content: r.content,
  }));
}
