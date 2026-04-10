/**
 * Example 02: Tool-Calling Agent
 *
 * Demonstrates a ReAct-style agent that uses tools to answer questions.
 * Uses a fake model for deterministic, no-API-key-needed execution.
 */
import {
  createExecutionContext,
  createEventBus,
  createToolRegistry,
  defineTool,
} from '@weaveintel/core';
import { createToolCallingAgent } from '@weaveintel/agents';
import { createFakeModel } from '@weaveintel/testing';

async function main() {
  const bus = createEventBus();
  const ctx = createExecutionContext({ userId: 'demo-user' });

  // Define tools
  const tools = createToolRegistry();

  tools.register(
    defineTool({
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
    defineTool({
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

  // Create the agent with a fake model that returns tool calls
  const model = createFakeModel({
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

  const agent = createToolCallingAgent({
    model,
    tools,
    bus,
    systemPrompt: 'You are a helpful agent with access to weather and math tools.',
    maxSteps: 5,
  });

  // Run the agent
  const result = await agent.run(
    { messages: [{ role: 'user', content: 'What is the weather in Paris?' }] },
    ctx,
  );

  console.log('Agent result:', result.output);
  console.log('Steps taken:', result.steps.length);
  for (const step of result.steps) {
    console.log(`  Step: ${step.action} → ${step.observation}`);
  }
}

main().catch(console.error);
