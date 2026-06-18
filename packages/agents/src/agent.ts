/**
 * @weaveintel/agents — Tool-calling agent runtime
 *
 * Implements the ReAct-style tool-calling loop:
 *   1. Send messages to model
 *   2. If model returns tool calls → execute tools → append results → loop
 *   3. If model returns text → return as final response
 *
 * Supports budget enforcement, step tracking, policy checks, streaming,
 * and graceful cancellation.
 */

import type {
  Agent,
  AgentConfig,
  AgentInput,
  AgentResult,
  AgentStep,
  AgentStepEvent,
  AgentUsage,
  AgentMemory,
  AgentPolicy,
  Critic,
  Verifier,
  Model,
  Message,
  ToolCall,
  ToolRegistry,
  ExecutionContext,
  EventBus,
  SupervisorConfig,
} from '@weaveintel/core';
import {
  WeaveIntelError,
  isExpired,
  weaveChildContext,
  weaveEvent,
  EventTypes,
  weaveToolRegistry,
  weaveResolveTracer,
  weaveAudit,
} from '@weaveintel/core';
import { buildSupervisorRuntime, type WorkerDefinition } from './supervisor-runtime.js';

async function withObservedSpan<T>(
  ctx: ExecutionContext,
  name: string,
  attributes: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = weaveResolveTracer(ctx);
  if (!tracer) {
    return fn();
  }
  return tracer.withSpan(ctx, name, () => fn(), attributes);
}

// ─── Agent builder ───────────────────────────────────────────

export interface ToolCallingAgentOptions {
  /** Model to use for generation */
  model: Model;
  /** Tool registry */
  tools?: ToolRegistry;
  /** Event bus for observability */
  bus?: EventBus;
  /** System prompt / instructions */
  systemPrompt?: string;
  /** Maximum number of tool-call loops before stopping */
  maxSteps?: number;
  /** Agent name */
  name?: string;
  /** Agent memory */
  memory?: AgentMemory;
  /** Policy for approval / budget */
  policy?: AgentPolicy;
  /**
   * Worker agents to delegate to. When provided, this agent runs in
   * supervisor mode: built-in `think`, `plan`, and `delegate_to_worker`
   * tools are auto-registered and the system prompt is composed with the
   * supervisor workflow guidance.
   */
  workers?: WorkerDefinition[];
  /**
   * Additional tools the supervisor may call directly (e.g. CSE / MCP
   * tools). Only meaningful when `workers` is set.
   */
  additionalTools?: ToolRegistry;
  /**
   * Tool names treated as CSE code-execution endpoints by the supervisor's
   * delegate-to-code redirection. Only meaningful when `workers` is set.
   */
  cseCodeToolNames?: string[];
  /**
   * When true (default), the supervisor receives pure utility tools
   * (`datetime`, `math_eval`, `unit_convert`) in addition to think/plan/
   * delegate_to_worker. Set to false to opt out (e.g. for ultra-minimal
   * supervisors). Only meaningful when `workers` is set.
   */
  includeUtilityTools?: boolean;
  /** Default timezone passed to the supervisor's `datetime` utility tool. */
  defaultTimezone?: string;
  /**
   * Maximum number of delegations. Only meaningful when `workers` is set.
   * Defaults to `maxSteps` when omitted.
   */
  maxDelegations?: number;
  /**
   * W3 — Re-plan on failure. Only meaningful when `workers` is set.
   * When true, failed worker results include a REPLAN_REQUIRED signal so the
   * supervisor LLM knows to revise its plan rather than give up.
   */
  replanOnFailure?: boolean;
  /**
   * W3 — Parallel delegation. Only meaningful when `workers` is set.
   * When true, a `delegate_to_workers_parallel` batch tool is registered so
   * the supervisor can dispatch independent sub-tasks concurrently.
   */
  parallelDelegation?: boolean;
  /**
   * W1 — Reflection mode: self-correction loop at each terminal response.
   * When set, the agent critiques its own output before returning. If the
   * critique rejects, feedback is appended as a new user turn and the loop
   * continues. Consumes from the shared `maxSteps` budget.
   * Default: not set (reflection disabled).
   */
  reflect?: {
    /** Maximum number of revision cycles before accepting as-is. Default 1. */
    maxRevisions?: number;
    /** Criteria text describing what "good" means. Fed to the critic prompt. */
    criteria?: string;
    /** Critic implementation. Defaults to a self-critic using the same model. */
    critic?: Critic;
    /** For scored critics: accept when score >= minScore. Default 0.7. */
    minScore?: number;
  };
  /**
   * W2 — Evaluator-optimizer mode: verify→regenerate loop at each terminal
   * response. When set, the verifier runs after guardrails; if it returns
   * `passed: false`, the output is appended as "failed verification" and the
   * loop regenerates. Shares the `maxSteps` budget.
   * Default: not set (verify disabled).
   */
  verify?: {
    /** Verifier implementation. */
    verifier: Verifier;
    /** Maximum regeneration attempts. Default 1. */
    maxAttempts?: number;
  };
}

// ─── Reflection / verify shared helper ───────────────────────

/**
 * Lazily build the default self-critic (loaded only when reflect is used).
 * Dynamic import keeps reflect.ts out of the critical path for non-reflect agents.
 */
async function buildDefaultCritic(model: Model, criteria?: string): Promise<Critic> {
  const { createSelfCritic } = await import('./reflect.js');
  return createSelfCritic({ model, criteria });
}

export function weaveAgent(opts: ToolCallingAgentOptions): Agent {
  const isSupervisor = Array.isArray(opts.workers) && opts.workers.length > 0;
  const supervisorRuntime = isSupervisor
    ? buildSupervisorRuntime({
        supervisorName: opts.name ?? 'supervisor',
        baseInstructions: opts.systemPrompt,
        workers: opts.workers!,
        buildWorkerAgent: (w, bus) => weaveAgent({
          name: w.name,
          model: w.model,
          systemPrompt: w.systemPrompt,
          tools: w.tools,
          bus,
        }),
        maxDelegations: opts.maxDelegations ?? opts.maxSteps ?? 10,
        bus: opts.bus,
        policy: opts.policy,
        additionalTools: opts.additionalTools,
        cseCodeToolNames: opts.cseCodeToolNames,
        includeUtilityTools: opts.includeUtilityTools,
        defaultTimezone: opts.defaultTimezone,
        replanOnFailure: opts.replanOnFailure,
        parallelDelegation: opts.parallelDelegation,
      })
    : undefined;

  const baseConfig: AgentConfig = {
    name: opts.name ?? (isSupervisor ? 'supervisor' : 'tool-agent'),
    instructions: supervisorRuntime?.systemPrompt ?? opts.systemPrompt,
    maxSteps: opts.maxSteps ?? (isSupervisor ? 30 : 20),
  };
  const config: AgentConfig | SupervisorConfig = supervisorRuntime
    ? {
        ...baseConfig,
        workers: supervisorRuntime.workersConfig,
        maxDelegations: opts.maxDelegations ?? opts.maxSteps ?? 10,
      } as SupervisorConfig
    : baseConfig;
  const { model, memory, policy } = opts;
  const eventBus = opts.bus;
  const maxSteps = config.maxSteps ?? 20;
  const toolReg = supervisorRuntime?.tools ?? opts.tools ?? weaveToolRegistry();

  return {
    config,

    async run(ctx: ExecutionContext, input: AgentInput): Promise<AgentResult> {
      const startTime = Date.now();
      const steps: AgentStep[] = [];
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let toolCallCount = 0;
      // W1/W2 — track revision/verify budgets across the loop
      let revisionCount = 0;
      let verifyAttemptCount = 0;
      // Lazily resolved default critic (only when reflect is used without explicit critic)
      let resolvedCritic: Critic | undefined;

      eventBus?.emit(weaveEvent(EventTypes.AgentRunStart, { agent: config.name, goal: input.goal }, ctx));
      void weaveAudit(ctx, { action: 'agent.run.start', outcome: 'success', resource: config.name, details: { goal: input.goal } });

      // Build conversation from history + input
      const messages: Message[] = [];
      if (config.instructions) {
        messages.push({ role: 'system', content: config.instructions });
      }

      // Load memory if available
      if (memory) {
        const history = await memory.getMessages(ctx);
        messages.push(...history);
      }
      messages.push(...input.messages);

      // Build tool definitions for the model
      const toolDefs = toolReg.toDefinitions();

      try {
        for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
          // Context checks
          if (isExpired(ctx)) {
            return buildResult(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, 'cancelled');
          }

          // Budget check
          if (config.maxTokenBudget && (totalPromptTokens + totalCompletionTokens) >= config.maxTokenBudget) {
            return buildResult(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, 'budget_exceeded');
          }

          // Policy check
          if (policy) {
            const usage = buildUsage(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime);
            const decision = await policy.shouldContinue(ctx, steps, usage);
            if (!decision.continue) {
              return buildResult(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, 'cancelled');
            }
          }

          const stepStart = Date.now();
          eventBus?.emit(weaveEvent(EventTypes.AgentStepStart, { agent: config.name, stepIndex: stepIdx }, ctx));

          // Call model
          const response = await withObservedSpan(
            ctx,
            'agents.model.generate',
            { agent: config.name, stepIndex: stepIdx, mode: 'run' },
            () => model.generate(ctx, {
              messages,
              tools: toolDefs.length > 0 ? toolDefs : undefined,
              toolChoice: toolDefs.length > 0 ? 'auto' : undefined,
            }),
          );

          totalPromptTokens += response.usage.promptTokens;
          totalCompletionTokens += response.usage.completionTokens;

          // Handle tool calls
          if (response.toolCalls && response.toolCalls.length > 0) {
            // Append assistant message with tool calls
            messages.push({
              role: 'assistant',
              content: response.content || '',
              toolCalls: response.toolCalls,
            });

            for (const tc of response.toolCalls) {
              const toolStep = await executeToolCall(
                ctx, tc, toolReg, policy, eventBus, config.name, stepIdx, stepStart,
              );
              steps.push(toolStep);
              toolCallCount++;

              // Append tool result to conversation
              messages.push({
                role: 'tool',
                content: toolStep.toolCall?.result ?? '',
                toolCallId: tc.id,
              });
            }

            eventBus?.emit(weaveEvent(EventTypes.AgentStepEnd, {
              agent: config.name,
              stepIndex: stepIdx,
              type: 'tool_call',
            }, ctx));
            continue;
          }

          // No tool calls — this is a terminal response.
          // Phase 5: consult runtime guardrails.checkOutput before surfacing
          // the response. A deny is fail-closed + audited; a redactedText
          // replacement is used as-is. Missing slot = allow-all (graceful).
          let finalContent = response.content;
          const outputGuardrails = ctx.runtime?.guardrails;
          if (outputGuardrails?.checkOutput) {
            let outputDecision: { allow: boolean; redactedText?: string; reason?: string } = { allow: true };
            try {
              outputDecision = await outputGuardrails.checkOutput(ctx, response.content);
            } catch (err) {
              outputDecision = { allow: false, reason: `guardrails error: ${err instanceof Error ? err.message : String(err)}` };
            }
            if (!outputDecision.allow) {
              const deniedContent = `Response blocked by guardrails: ${outputDecision.reason ?? 'no reason'}`;
              void weaveAudit(ctx, { action: 'agent.output.denied', outcome: 'denied', resource: config.name, details: { reason: outputDecision.reason ?? 'guardrails' } });
              const deniedStep: AgentStep = {
                index: steps.length,
                type: 'response',
                content: deniedContent,
                durationMs: Date.now() - stepStart,
                tokenUsage: { prompt: response.usage.promptTokens, completion: response.usage.completionTokens },
              };
              steps.push(deniedStep);
              // M-21: return 'guardrail_denied' so callers can distinguish a
              // policy-blocked response from a legitimate completion.
              return buildResult(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, 'guardrail_denied');
            }
            if (outputDecision.redactedText !== undefined) {
              finalContent = outputDecision.redactedText;
            }
          }

          // ── W2: Verify →regenerate ────────────────────────────────────────
          if (opts.verify && !isExpired(ctx)) {
            const maxAttempts = opts.verify.maxAttempts ?? 1;
            if (verifyAttemptCount < maxAttempts) {
              let verifyResult: { passed: boolean; reason?: string; score?: number };
              try {
                verifyResult = await opts.verify.verifier.verify(ctx, finalContent, { userInput: lastUserMessage(messages) });
              } catch (err) {
                verifyResult = { passed: false, reason: `verifier error: ${err instanceof Error ? err.message : String(err)}` };
              }
              if (!verifyResult.passed) {
                verifyAttemptCount++;
                void weaveAudit(ctx, {
                  action: 'agent.verify.failed',
                  outcome: 'failure',
                  resource: config.name,
                  details: { attempt: verifyAttemptCount, reason: verifyResult.reason, score: verifyResult.score },
                });
                const verifyFeedbackStep: AgentStep = {
                  index: steps.length,
                  type: 'thinking',
                  content: `[verify:failed attempt=${verifyAttemptCount}] ${verifyResult.reason ?? 'did not pass'}`,
                  durationMs: Date.now() - stepStart,
                  tokenUsage: { prompt: response.usage.promptTokens, completion: response.usage.completionTokens },
                };
                steps.push(verifyFeedbackStep);
                // Append failed output + regeneration request as new user turn
                messages.push({ role: 'assistant', content: finalContent });
                messages.push({
                  role: 'user',
                  content: `Your previous response did not pass verification (${verifyResult.reason ?? 'quality check failed'}). Please regenerate a better response.`,
                });
                continue;
              }
            }
          }

          // ── W1: Reflect →revise ───────────────────────────────────────────
          if (opts.reflect && !isExpired(ctx)) {
            const maxRevisions = opts.reflect.maxRevisions ?? 1;
            if (revisionCount < maxRevisions) {
              if (!resolvedCritic) {
                resolvedCritic = opts.reflect.critic ?? await buildDefaultCritic(model, opts.reflect.criteria);
              }
              let critiqueResult: { accepted: boolean; feedback?: string; score?: number };
              try {
                critiqueResult = await resolvedCritic.critique(ctx, lastUserMessage(messages), finalContent);
              } catch (err) {
                critiqueResult = { accepted: false, feedback: `critic error: ${err instanceof Error ? err.message : String(err)}` };
              }
              if (!critiqueResult.accepted) {
                revisionCount++;
                void weaveAudit(ctx, {
                  action: 'agent.reflect.revise',
                  outcome: 'success',
                  resource: config.name,
                  details: { revision: revisionCount, score: critiqueResult.score, feedback: critiqueResult.feedback },
                });
                const reflectStep: AgentStep = {
                  index: steps.length,
                  type: 'thinking',
                  content: `[reflect:revision=${revisionCount}] ${critiqueResult.feedback ?? 'critique requested revision'}`,
                  durationMs: Date.now() - stepStart,
                  tokenUsage: { prompt: response.usage.promptTokens, completion: response.usage.completionTokens },
                };
                steps.push(reflectStep);
                // Append draft + critique feedback as new user turn
                messages.push({ role: 'assistant', content: finalContent });
                messages.push({
                  role: 'user',
                  content: `Please revise your response based on this feedback: ${critiqueResult.feedback ?? 'Improve the quality of your answer.'}`,
                });
                continue;
              }
              void weaveAudit(ctx, {
                action: 'agent.reflect.accepted',
                outcome: 'success',
                resource: config.name,
                details: { revision: revisionCount, score: critiqueResult.score },
              });
            }
          }

          const responseStep: AgentStep = {
            index: steps.length,
            type: 'response',
            content: finalContent,
            durationMs: Date.now() - stepStart,
            tokenUsage: { prompt: response.usage.promptTokens, completion: response.usage.completionTokens },
          };
          steps.push(responseStep);

          eventBus?.emit(weaveEvent(EventTypes.AgentStepEnd, {
            agent: config.name,
            stepIndex: stepIdx,
            type: 'response',
          }, ctx));

          // Save to memory
          if (memory) {
            for (const msg of input.messages) {
              await memory.addMessage(ctx, msg);
            }
            await memory.addMessage(ctx, { role: 'assistant', content: finalContent });
          }

          eventBus?.emit(weaveEvent(EventTypes.AgentRunEnd, {
            agent: config.name,
            status: 'completed',
            steps: steps.length,
          }, ctx));
          void weaveAudit(ctx, { action: 'agent.run.end', outcome: 'success', resource: config.name, details: { steps: steps.length, status: 'completed' } });

          return buildResult(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, 'completed');
        }

        // Max steps exceeded
        return buildResult(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, 'failed');
      } catch (err) {
        eventBus?.emit(weaveEvent(EventTypes.AgentRunEnd, {
          agent: config.name,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        }, ctx));
        void weaveAudit(ctx, { action: 'agent.run.end', outcome: 'failure', resource: config.name, details: { error: err instanceof Error ? err.message : String(err) } });
        throw err;
      }
    },

    async *runStream(ctx: ExecutionContext, input: AgentInput): AsyncIterable<AgentStepEvent> {
      const startTime = Date.now();
      const steps: AgentStep[] = [];
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let toolCallCount = 0;
      // W1/W2 — reflect/verify budgets for runStream
      let streamRevisionCount = 0;
      let streamVerifyAttemptCount = 0;
      let streamResolvedCritic: Critic | undefined;
      // M-21: track guardrail denial for stream path so the final 'done' event
      // carries 'guardrail_denied' instead of 'completed'.
      let streamGuardrailDenied = false;

      const messages: Message[] = [];
      if (config.instructions) {
        messages.push({ role: 'system', content: config.instructions });
      }
      if (memory) {
        const history = await memory.getMessages(ctx);
        messages.push(...history);
      }
      messages.push(...input.messages);

      const toolDefs = toolReg.toDefinitions();

      for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
        if (isExpired(ctx)) break;

        if (config.maxTokenBudget && (totalPromptTokens + totalCompletionTokens) >= config.maxTokenBudget) break;

        const stepStart = Date.now();
        yield { type: 'step_start', step: { index: stepIdx, type: 'thinking', durationMs: 0 } };

        // Check if model supports streaming
        if (model.stream) {
          let accText = '';
          let accToolCalls: ToolCall[] = [];
          let finalUsage = { prompt: 0, completion: 0 };

          for await (const chunk of await withObservedSpan(
            ctx,
            'agents.model.stream',
            { agent: config.name, stepIndex: stepIdx, mode: 'stream' },
            () => Promise.resolve(model.stream!(ctx, {
              messages,
              tools: toolDefs.length > 0 ? toolDefs : undefined,
              toolChoice: toolDefs.length > 0 ? 'auto' : undefined,
            })),
          )) {
            if (chunk.type === 'text' && chunk.text) {
              accText += chunk.text;
              yield { type: 'text_chunk', text: chunk.text };
            }
            if (chunk.type === 'tool_call' && chunk.toolCall) {
              const tc = chunk.toolCall as ToolCall;
              if (tc.id && tc.name) {
                // New tool call start
                accToolCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments || '' });
              } else if (tc.arguments && accToolCalls.length > 0) {
                // Incremental arguments delta — append to last tool call
                const last = accToolCalls[accToolCalls.length - 1]!;
                (last as { id: string; name: string; arguments: string }).arguments += tc.arguments;
              }
            }
            if (chunk.type === 'usage' && chunk.usage) {
              finalUsage = { prompt: chunk.usage.promptTokens, completion: chunk.usage.completionTokens };
            }
          }

          totalPromptTokens += finalUsage.prompt;
          totalCompletionTokens += finalUsage.completion;

          if (accToolCalls.length > 0) {
            messages.push({ role: 'assistant', content: accText || '', toolCalls: accToolCalls });

            for (const tc of accToolCalls) {
              yield { type: 'tool_start', step: { index: steps.length, type: 'tool_call', content: tc.name, durationMs: 0 } };

              const toolStep = await executeToolCall(ctx, tc, toolReg, policy, eventBus, config.name, stepIdx, stepStart);
              steps.push(toolStep);
              toolCallCount++;

              messages.push({ role: 'tool', content: toolStep.toolCall?.result ?? '', toolCallId: tc.id });

              yield { type: 'tool_end', step: toolStep };
            }
            continue;
          }

          // Terminal response via streaming — H-18: delegate to shared post-processor.
          const streamTerminal = await processTerminalResponse({
            ctx, model, rawContent: accText, agentName: config.name,
            messages, steps, stepStart, tokenUsage: finalUsage,
            verifyOpts: opts.verify, reflectOpts: opts.reflect,
            verifyAttemptCount: streamVerifyAttemptCount,
            revisionCount: streamRevisionCount,
            resolvedCritic: streamResolvedCritic,
            guardrailDenied: streamGuardrailDenied,
          });
          streamVerifyAttemptCount = streamTerminal.verifyAttemptCount;
          streamRevisionCount = streamTerminal.revisionCount;
          streamResolvedCritic = streamTerminal.resolvedCritic;
          streamGuardrailDenied = streamTerminal.guardrailDenied;

          if (streamTerminal.result.action === 'continue') {
            for (const ev of streamTerminal.result.events) yield ev;
            messages.push(...streamTerminal.result.appendMessages);
            continue;
          }

          const { finalContent: streamFinalContent } = streamTerminal.result;
          const responseStep: AgentStep = {
            index: steps.length,
            type: 'response',
            content: streamFinalContent,
            durationMs: Date.now() - stepStart,
            tokenUsage: finalUsage,
          };
          steps.push(responseStep);
          yield { type: 'step_end', step: responseStep };
          yield {
            type: 'done',
            // M-21: use guardrail_denied when output guardrail blocked the response
            result: buildResult(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, streamGuardrailDenied ? 'guardrail_denied' : 'completed'),
          };
          return;
        }

        // Non-streaming fallback
        const response = await withObservedSpan(
          ctx,
          'agents.model.generate',
          { agent: config.name, stepIndex: stepIdx, mode: 'stream-fallback' },
          () => model.generate(ctx, {
            messages,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
            toolChoice: toolDefs.length > 0 ? 'auto' : undefined,
          }),
        );

        totalPromptTokens += response.usage.promptTokens;
        totalCompletionTokens += response.usage.completionTokens;

        if (response.toolCalls && response.toolCalls.length > 0) {
          messages.push({ role: 'assistant', content: response.content || '', toolCalls: response.toolCalls });

          for (const tc of response.toolCalls) {
            yield { type: 'tool_start', step: { index: steps.length, type: 'tool_call', content: tc.name, durationMs: 0 } };

            const toolStep = await executeToolCall(ctx, tc, toolReg, policy, eventBus, config.name, stepIdx, stepStart);
            steps.push(toolStep);
            toolCallCount++;

            messages.push({ role: 'tool', content: toolStep.toolCall?.result ?? '', toolCallId: tc.id });
            yield { type: 'tool_end', step: toolStep };
          }
          continue;
        }

        // ── H-18: fallback terminal — same post-processor as streaming path ──
        const fallbackUsage = { prompt: response.usage.promptTokens, completion: response.usage.completionTokens };
        const fallbackTerminal = await processTerminalResponse({
          ctx, model, rawContent: response.content, agentName: config.name,
          messages, steps, stepStart, tokenUsage: fallbackUsage,
          verifyOpts: opts.verify, reflectOpts: opts.reflect,
          verifyAttemptCount: streamVerifyAttemptCount,
          revisionCount: streamRevisionCount,
          resolvedCritic: streamResolvedCritic,
          guardrailDenied: streamGuardrailDenied,
        });
        streamVerifyAttemptCount = fallbackTerminal.verifyAttemptCount;
        streamRevisionCount = fallbackTerminal.revisionCount;
        streamResolvedCritic = fallbackTerminal.resolvedCritic;
        streamGuardrailDenied = fallbackTerminal.guardrailDenied;

        if (fallbackTerminal.result.action === 'continue') {
          for (const ev of fallbackTerminal.result.events) yield ev;
          messages.push(...fallbackTerminal.result.appendMessages);
          continue;
        }

        const responseStep: AgentStep = {
          index: steps.length,
          type: 'response',
          content: fallbackTerminal.result.finalContent,
          durationMs: Date.now() - stepStart,
          tokenUsage: fallbackUsage,
        };
        steps.push(responseStep);
        yield { type: 'step_end', step: responseStep };
        yield {
          type: 'done',
          // M-21: propagate guardrail denial on the fallback path too
          result: buildResult(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, streamGuardrailDenied ? 'guardrail_denied' : 'completed'),
        };
        return;
      }

      // Reached max steps
      yield {
        type: 'done',
        result: buildResult(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, 'failed'),
      };
    },
  };
}

// ─── Terminal response post-processor (H-18) ─────────────────
//
// Shared by the streaming and non-streaming fallback paths inside runStream().
// Both paths do: guardrail-check → W2-verify → W1-reflect → finalize.
// The only difference is which AgentStepEvent type to yield back — the caller
// iterates `events` and yields them, then acts on `action`.

type TerminalResponseAction =
  | {
      /** Continue the step loop — verify or reflect requested a revision. */
      action: 'continue';
      /** Events to yield before looping (verify_failed / reflect_revised). */
      events: AgentStepEvent[];
      /** Messages to append before looping. */
      appendMessages: Message[];
    }
  | {
      /** Terminal: all checks passed (or were skipped). */
      action: 'done';
      finalContent: string;
      guardrailDenied: boolean;
    };

async function processTerminalResponse(opts: {
  ctx: ExecutionContext;
  model: Model;
  rawContent: string;
  agentName: string;
  messages: Message[];
  steps: AgentStep[];
  stepStart: number;
  tokenUsage: { prompt: number; completion: number };
  verifyOpts?: { verifier: { verify(ctx: ExecutionContext, content: string, meta: { userInput: string }): Promise<{ passed: boolean; reason?: string; score?: number }> }; maxAttempts?: number };
  reflectOpts?: { critic?: Critic; maxRevisions?: number; criteria?: string };
  verifyAttemptCount: number;
  revisionCount: number;
  resolvedCritic: Critic | undefined;
  guardrailDenied: boolean;
}): Promise<{
  result: TerminalResponseAction;
  verifyAttemptCount: number;
  revisionCount: number;
  resolvedCritic: Critic | undefined;
  guardrailDenied: boolean;
}> {
  let { verifyAttemptCount, revisionCount, resolvedCritic, guardrailDenied } = opts;
  const { ctx, agentName, messages, steps, stepStart, tokenUsage } = opts;

  // ── Guardrail output check ────────────────────────────────────────────────
  let finalContent = opts.rawContent;
  const outputGuardrails = ctx.runtime?.guardrails;
  if (outputGuardrails?.checkOutput) {
    let decision: { allow: boolean; redactedText?: string; reason?: string } = { allow: true };
    try {
      decision = await outputGuardrails.checkOutput(ctx, opts.rawContent);
    } catch (err) {
      decision = { allow: false, reason: `guardrails error: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!decision.allow) {
      void weaveAudit(ctx, { action: 'agent.output.denied', outcome: 'denied', resource: agentName, details: { reason: decision.reason ?? 'guardrails' } });
      finalContent = `Response blocked by guardrails: ${decision.reason ?? 'no reason'}`;
      guardrailDenied = true;
    } else if (decision.redactedText !== undefined) {
      finalContent = decision.redactedText;
    }
  }

  // ── W2: verify → regenerate ───────────────────────────────────────────────
  if (opts.verifyOpts && !isExpired(ctx)) {
    const maxAttempts = opts.verifyOpts.maxAttempts ?? 1;
    if (verifyAttemptCount < maxAttempts) {
      let vr: { passed: boolean; reason?: string; score?: number };
      try {
        vr = await opts.verifyOpts.verifier.verify(ctx, finalContent, { userInput: lastUserMessage(messages) });
      } catch (err) {
        vr = { passed: false, reason: `verifier error: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!vr.passed) {
        verifyAttemptCount++;
        void weaveAudit(ctx, { action: 'agent.verify.failed', outcome: 'failure', resource: agentName, details: { attempt: verifyAttemptCount, reason: vr.reason, score: vr.score } });
        const vStep: AgentStep = { index: steps.length, type: 'thinking', content: `[verify:failed attempt=${verifyAttemptCount}] ${vr.reason ?? 'did not pass'}`, durationMs: Date.now() - stepStart, tokenUsage };
        steps.push(vStep);
        return {
          result: {
            action: 'continue',
            events: [{ type: 'verify_failed', step: vStep }],
            appendMessages: [
              { role: 'assistant', content: finalContent },
              { role: 'user', content: `Your previous response did not pass verification (${vr.reason ?? 'quality check failed'}). Please regenerate a better response.` },
            ],
          },
          verifyAttemptCount, revisionCount, resolvedCritic, guardrailDenied,
        };
      }
    }
  }

  // ── W1: reflect → revise ─────────────────────────────────────────────────
  if (opts.reflectOpts && !isExpired(ctx)) {
    const maxRevisions = opts.reflectOpts.maxRevisions ?? 1;
    if (revisionCount < maxRevisions) {
      if (!resolvedCritic) {
        resolvedCritic = opts.reflectOpts.critic ?? await buildDefaultCritic(opts.model, opts.reflectOpts.criteria);
      }
      let cr: { accepted: boolean; feedback?: string; score?: number };
      try {
        cr = await resolvedCritic.critique(ctx, lastUserMessage(messages), finalContent);
      } catch (err) {
        cr = { accepted: false, feedback: `critic error: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!cr.accepted) {
        revisionCount++;
        void weaveAudit(ctx, { action: 'agent.reflect.revise', outcome: 'success', resource: agentName, details: { revision: revisionCount, score: cr.score, feedback: cr.feedback } });
        const rStep: AgentStep = { index: steps.length, type: 'thinking', content: `[reflect:revision=${revisionCount}] ${cr.feedback ?? 'critique requested revision'}`, durationMs: Date.now() - stepStart, tokenUsage };
        steps.push(rStep);
        return {
          result: {
            action: 'continue',
            events: [{ type: 'reflect_revised', step: rStep }],
            appendMessages: [
              { role: 'assistant', content: finalContent },
              { role: 'user', content: `Please revise your response based on this feedback: ${cr.feedback ?? 'Improve the quality of your answer.'}` },
            ],
          },
          verifyAttemptCount, revisionCount, resolvedCritic, guardrailDenied,
        };
      }
      void weaveAudit(ctx, { action: 'agent.reflect.accepted', outcome: 'success', resource: agentName, details: { revision: revisionCount, score: cr.score } });
    }
  }

  return {
    result: { action: 'done', finalContent, guardrailDenied },
    verifyAttemptCount, revisionCount, resolvedCritic, guardrailDenied,
  };
}

// ─── Tool execution helper ───────────────────────────────────

async function executeToolCall(
  ctx: ExecutionContext,
  tc: ToolCall,
  toolReg: ToolRegistry,
  policy: AgentPolicy | undefined,
  eventBus: EventBus | undefined,
  agentName: string,
  _stepIdx: number,
  stepStart: number,
): Promise<AgentStep> {
  const tool = toolReg.get(tc.name);
  const toolName = tc.name;
  const guardrails = ctx.runtime?.guardrails;

  eventBus?.emit(weaveEvent(EventTypes.ToolCallStart, { tool: toolName, agent: agentName }, ctx));

  let resultContent: string;

  if (!tool) {
    resultContent = `Error: Tool "${tc.name}" not found. Available tools: ${toolReg.list().map((t) => t.schema.name).join(', ')}`;
    void weaveAudit(ctx, { action: 'agent.tool.invoke', outcome: 'failure', resource: toolName, details: { agent: agentName, reason: 'not_found' } });
  } else {
    // Ambient guardrails (Phase 3): preferred over the legacy per-agent
    // `policy.approveToolCall` so cross-cutting policy can live on the
    // runtime and apply uniformly across every agent in the process.
    if (guardrails?.checkToolCall) {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(tc.arguments) as Record<string, unknown>; } catch { /* keep empty */ }
      let decision: { allow: boolean; reason?: string } = { allow: true };
      try {
        decision = await guardrails.checkToolCall(ctx, tool.schema, parsed);
      } catch (err) {
        // Guardrails throwing means *fail closed* + audit; agents must
        // never silently bypass an erroring policy check.
        decision = { allow: false, reason: `guardrails error: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!decision.allow) {
        resultContent = `Tool call denied by guardrails: ${decision.reason ?? 'no reason'}`;
        eventBus?.emit(weaveEvent(EventTypes.ToolCallError, { tool: toolName, reason: 'guardrails_denied' }, ctx));
        void weaveAudit(ctx, { action: 'agent.tool.invoke', outcome: 'denied', resource: toolName, details: { agent: agentName, reason: decision.reason ?? 'guardrails' } });
        return {
          index: 0,
          type: 'tool_call',
          toolCall: { name: toolName, arguments: parsed, result: resultContent },
          durationMs: Date.now() - stepStart,
        };
      }
    }

    // Legacy per-agent policy hook — still honoured for backwards compat.
    // H-11: use safeParseJson so a malformed arguments string from the model
    // does not throw an unhandled exception that bypasses the denial logic.
    // On parse failure, block the tool call and return an error result — it is
    // safer to deny a call with unparseable arguments than to let it through.
    if (policy?.approveToolCall) {
      let policyArgs: Record<string, unknown>;
      try {
        policyArgs = JSON.parse(tc.arguments) as Record<string, unknown>;
      } catch (parseErr) {
        // Arguments string is invalid JSON — block the call rather than crash.
        const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        resultContent = `Tool call blocked: could not parse tool arguments — ${errMsg}`;
        eventBus?.emit(weaveEvent(EventTypes.ToolCallError, { tool: toolName, reason: 'invalid_arguments' }, ctx));
        void weaveAudit(ctx, { action: 'agent.tool.invoke', outcome: 'denied', resource: toolName, details: { agent: agentName, reason: 'invalid_arguments', raw: tc.arguments.slice(0, 200) } });
        return {
          index: 0,
          type: 'tool_call',
          toolCall: { name: toolName, arguments: { _raw: tc.arguments }, result: resultContent },
          durationMs: Date.now() - stepStart,
        };
      }
      const decision = await policy.approveToolCall(ctx, tool.schema, policyArgs);
      if (!decision.approved) {
        resultContent = `Tool call denied by policy: ${decision.reason ?? 'no reason'}`;
        eventBus?.emit(weaveEvent(EventTypes.ToolCallError, { tool: toolName, reason: 'policy_denied' }, ctx));
        void weaveAudit(ctx, { action: 'agent.tool.invoke', outcome: 'denied', resource: toolName, details: { agent: agentName, reason: decision.reason ?? 'policy' } });
        return {
          index: 0,
          type: 'tool_call',
          toolCall: { name: toolName, arguments: policyArgs, result: resultContent },
          durationMs: Date.now() - stepStart,
        };
      }
    }

    try {
      const args = JSON.parse(tc.arguments);
      const output = await withObservedSpan(
        ctx,
        'agents.tool.invoke',
        { agent: agentName, tool: toolName },
        () => tool.invoke(ctx, { name: toolName, arguments: args }),
      );
      resultContent = output.isError ? `Error: ${output.content}` : output.content;
      void weaveAudit(ctx, {
        action: 'agent.tool.invoke',
        outcome: output.isError ? 'failure' : 'success',
        resource: toolName,
        details: { agent: agentName },
      });
    } catch (err) {
      resultContent = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
      void weaveAudit(ctx, { action: 'agent.tool.invoke', outcome: 'failure', resource: toolName, details: { agent: agentName, error: err instanceof Error ? err.message : String(err) } });
    }
  }

  eventBus?.emit(weaveEvent(EventTypes.ToolCallEnd, { tool: toolName, agent: agentName, result: resultContent }, ctx));

  return {
    index: 0,
    type: 'tool_call',
    toolCall: { name: toolName, arguments: safeParseJson(tc.arguments), result: resultContent },
    durationMs: Date.now() - stepStart,
  };
}

function safeParseJson(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str) as Record<string, unknown>;
  } catch {
    return { _raw: str };
  }
}

// ─── Result builders ─────────────────────────────────────────

function buildUsage(
  steps: AgentStep[],
  promptTokens: number,
  completionTokens: number,
  toolCallCount: number,
  startTime: number,
): AgentUsage {
  return {
    totalSteps: steps.length,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    totalDurationMs: Date.now() - startTime,
    toolCalls: toolCallCount,
    delegations: steps.filter((s) => s.type === 'delegation').length,
  };
}

function buildResult(
  steps: AgentStep[],
  promptTokens: number,
  completionTokens: number,
  toolCallCount: number,
  startTime: number,
  status: AgentResult['status'],
): AgentResult {
  const lastResponse = [...steps].reverse().find((s) => s.type === 'response');
  return {
    output: lastResponse?.content ?? '',
    messages: [],
    steps,
    usage: buildUsage(steps, promptTokens, completionTokens, toolCallCount, startTime),
    status,
  };
}

/** Extract the most recent user-role message content from the conversation. */
function lastUserMessage(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return String(messages[i]!.content);
  }
  return '';
}
