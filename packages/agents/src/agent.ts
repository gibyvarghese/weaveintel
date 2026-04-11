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
  Model,
  Message,
  ToolCall,
  ToolRegistry,
  ExecutionContext,
  EventBus,
} from '@weaveintel/core';
import {
  WeaveIntelError,
  isExpired,
  weaveChildContext,
  weaveEvent,
  EventTypes,
  weaveToolRegistry,
} from '@weaveintel/core';

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
}

export function weaveAgent(opts: ToolCallingAgentOptions): Agent {
  const config: AgentConfig = {
    name: opts.name ?? 'tool-agent',
    instructions: opts.systemPrompt,
    maxSteps: opts.maxSteps ?? 20,
  };
  const { model, memory, policy } = opts;
  const eventBus = opts.bus;
  const maxSteps = config.maxSteps ?? 20;
  const toolReg = opts.tools ?? weaveToolRegistry();

  return {
    config,

    async run(ctx: ExecutionContext, input: AgentInput): Promise<AgentResult> {
      const startTime = Date.now();
      const steps: AgentStep[] = [];
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let toolCallCount = 0;

      eventBus?.emit(weaveEvent(EventTypes.AgentRunStart, { agent: config.name, goal: input.goal }, ctx));

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
          const response = await model.generate(ctx, {
            messages,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
            toolChoice: toolDefs.length > 0 ? 'auto' : undefined,
          });

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

          // No tool calls — this is a terminal response
          const responseStep: AgentStep = {
            index: steps.length,
            type: 'response',
            content: response.content,
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
            await memory.addMessage(ctx, { role: 'assistant', content: response.content });
          }

          eventBus?.emit(weaveEvent(EventTypes.AgentRunEnd, {
            agent: config.name,
            status: 'completed',
            steps: steps.length,
          }, ctx));

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
        throw err;
      }
    },

    async *runStream(ctx: ExecutionContext, input: AgentInput): AsyncIterable<AgentStepEvent> {
      const startTime = Date.now();
      const steps: AgentStep[] = [];
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let toolCallCount = 0;

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

          for await (const chunk of model.stream(ctx, {
            messages,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
            toolChoice: toolDefs.length > 0 ? 'auto' : undefined,
          })) {
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

          // Terminal response via streaming
          const responseStep: AgentStep = {
            index: steps.length,
            type: 'response',
            content: accText,
            durationMs: Date.now() - stepStart,
            tokenUsage: finalUsage,
          };
          steps.push(responseStep);
          yield { type: 'step_end', step: responseStep };
          yield {
            type: 'done',
            result: buildResult(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, 'completed'),
          };
          return;
        }

        // Non-streaming fallback
        const response = await model.generate(ctx, {
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          toolChoice: toolDefs.length > 0 ? 'auto' : undefined,
        });

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

        const responseStep: AgentStep = {
          index: steps.length,
          type: 'response',
          content: response.content,
          durationMs: Date.now() - stepStart,
          tokenUsage: { prompt: response.usage.promptTokens, completion: response.usage.completionTokens },
        };
        steps.push(responseStep);
        yield { type: 'step_end', step: responseStep };
        yield {
          type: 'done',
          result: buildResult(steps, totalPromptTokens, totalCompletionTokens, toolCallCount, startTime, 'completed'),
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

  eventBus?.emit(weaveEvent(EventTypes.ToolCallStart, { tool: tc.name, agent: agentName }, ctx));

  let resultContent: string;

  if (!tool) {
    resultContent = `Error: Tool "${tc.name}" not found. Available tools: ${toolReg.list().map((t) => t.schema.name).join(', ')}`;
  } else {
    // Policy check
    if (policy?.approveToolCall) {
      const decision = await policy.approveToolCall(ctx, tool.schema, JSON.parse(tc.arguments));
      if (!decision.approved) {
        resultContent = `Tool call denied by policy: ${decision.reason ?? 'no reason'}`;
        eventBus?.emit(weaveEvent(EventTypes.ToolCallError, { tool: tc.name, reason: 'policy_denied' }, ctx));
        return {
          index: 0,
          type: 'tool_call',
          toolCall: { name: tc.name, arguments: JSON.parse(tc.arguments), result: resultContent },
          durationMs: Date.now() - stepStart,
        };
      }
    }

    try {
      const args = JSON.parse(tc.arguments);
      const output = await tool.invoke(ctx, { name: tc.name, arguments: args });
      resultContent = output.isError ? `Error: ${output.content}` : output.content;
    } catch (err) {
      resultContent = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  eventBus?.emit(weaveEvent(EventTypes.ToolCallEnd, { tool: tc.name, agent: agentName }, ctx));

  return {
    index: 0,
    type: 'tool_call',
    toolCall: { name: tc.name, arguments: safeParseJson(tc.arguments), result: resultContent },
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
