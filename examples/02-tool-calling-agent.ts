/**
 * Example 02: Tool-Calling Agent
 *
 * Demonstrates a ReAct-style agent that uses tools to answer questions.
 * Uses a fake model for deterministic, no-API-key-needed execution.
 *
 * WeaveIntel packages used:
 *   @weaveintel/core    — ExecutionContext, EventBus, ToolRegistry, and the weaveTool() factory
 *   @weaveintel/agents  — weaveAgent() creates a ReAct agent loop that alternates between
 *                         "think" (LLM call) and "act" (tool execution) steps
 *   @weaveintel/testing — weaveFakeModel() returns canned responses so the example runs
 *                         without an API key and produces deterministic output
 */
import {
  weaveContext,
  weaveEventBus,
  weaveToolRegistry,
  weaveTool,
} from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveFakeModel } from '@weaveintel/testing';

async function main() {
  const bus = weaveEventBus();
  const ctx = weaveContext({ userId: 'demo-user' });

  // weaveToolRegistry() creates a registry that the agent checks when the model
  // emits a tool_call. The registry maps tool names → Tool objects so the agent
  // loop can find and execute the right function.
  const tools = weaveToolRegistry();

  // weaveTool() constructs a Tool conforming to weaveIntel's Tool interface.
  // Each tool has:
  //   • name & description — sent to the LLM so it knows what tools are available
  //   • parameters         — JSON Schema describing the arguments the LLM must provide
  //   • execute            — async function that runs when the agent loop resolves a tool_call
  tools.register(
    weaveTool({
      name: 'get_weather',
      description: 'Get current weather for a city',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name' },
        },
        required: ['city'],
      },
      execute: async (args) => {
        const city = (args as { city: string }).city;
        // Simulated weather data
        const weather: Record<string, string> = {
          'Paris': '22°C, Sunny',
          'London': '16°C, Cloudy',
          'Tokyo': '28°C, Humid',
        };
        return weather[city] ?? `No data for ${city}`;
      },
    }),
  );

  tools.register(
    weaveTool({
      name: 'calculate',
      description: 'Evaluate a math expression',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Math expression' },
        },
        required: ['expression'],
      },
      execute: async (args) => {
        const expr = (args as { expression: string }).expression;
        // Simple safe eval for demo — production would use a math parser
        const result = Function(`"use strict"; return (${expr})`)();
        return String(result);
      },
    }),
  );

  // weaveFakeModel() returns responses from a pre-defined list, one per call.
  // The first response contains a toolCalls array telling the agent to invoke
  // 'get_weather'. The second response is the final answer (no tool calls),
  // which causes the agent loop to terminate.
  const model = weaveFakeModel({
    responses: [
      // Step 1: model calls the weather tool
      {
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      // Step 2: model synthesizes final answer
      {
        content: 'The weather in Paris is 22°C and Sunny!',
        toolCalls: [],
      },
    ],
  });

  // weaveAgent() wires together model + tools + event bus into a ReAct loop.
  // On each iteration the agent: (1) calls model.chat() with the conversation
  // so far, (2) if the response has tool_calls, executes each tool and appends
  // the result back as a 'tool' message, (3) repeats until the model responds
  // with plain content (no tool calls) or maxSteps is reached.
  const agent = weaveAgent({
    model,
    tools,
    bus,
    systemPrompt: 'You are a helpful agent with access to weather and math tools.',
    maxSteps: 5, // Safety limit — prevents infinite loops if the model keeps calling tools
  });

  // agent.run() kicks off the ReAct loop and returns an AgentResult:
  //   • .output — the final text answer produced by the model
  //   • .steps  — array of AgentStep objects recording each think/act event
  //              (step.type = 'model' | 'tool', with .content or .toolCall)
  const result = await agent.run(
    ctx,
    { messages: [{ role: 'user', content: 'What is the weather in Paris?' }] },
  );

  console.log('Agent result:', result.output);
  console.log('Steps taken:', result.steps.length);
  for (const step of result.steps) {
    console.log(`  Step [${step.type}]: ${step.content ?? step.toolCall?.name ?? ''}`);
  }
}

main().catch(console.error);
