/**
 * Example 04: Hierarchical Agents
 *
 * Demonstrates a supervisor agent that delegates tasks to specialized workers.
 * The supervisor decides which worker to route each sub-task to.
 */
import {
  createExecutionContext,
  createEventBus,
  createToolRegistry,
  defineTool,
} from '@weaveintel/core';
import { createSupervisor } from '@weaveintel/agents';
import { createFakeModel } from '@weaveintel/testing';

async function main() {
  const bus = createEventBus();
  const ctx = createExecutionContext({ userId: 'demo-user' });

  // Worker tools
  const researchTools = createToolRegistry();
  researchTools.register(
    defineTool({
      name: 'search_web',
      description: 'Search the web for information',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      execute: async (args) =>
        `Results for "${(args as { query: string }).query}": AI frameworks include LangChain, WeaveIntel, LlamaIndex.`,
    }),
  );

  const writerTools = createToolRegistry();
  writerTools.register(
    defineTool({
      name: 'write_document',
      description: 'Write a document from given notes',
      parameters: {
        type: 'object',
        properties: { notes: { type: 'string' } },
        required: ['notes'],
      },
      execute: async (args) =>
        `## Report\n\n${(args as { notes: string }).notes}\n\nThis report was auto-generated.`,
    }),
  );

  // Supervisor model: first delegates to researcher, then to writer, then summarizes
  const supervisorModel = createFakeModel({
    responses: [
      // Step 1: supervisor delegates to researcher
      {
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            function: {
              name: 'delegate_to_worker',
              arguments: JSON.stringify({
                worker: 'researcher',
                task: 'Search for popular AI frameworks',
              }),
            },
          },
        ],
      },
      // Step 2: supervisor delegates to writer
      {
        content: '',
        toolCalls: [
          {
            id: 'call_2',
            function: {
              name: 'delegate_to_worker',
              arguments: JSON.stringify({
                worker: 'writer',
                task: 'Write a brief summary about AI frameworks',
              }),
            },
          },
        ],
      },
      // Step 3: supervisor produces final answer
      {
        content: 'The research team found that popular AI frameworks include LangChain, WeaveIntel, and LlamaIndex. A report has been generated.',
        toolCalls: [],
      },
    ],
  });

  // Worker models
  const researcherModel = createFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [
          {
            id: 'wc_1',
            function: {
              name: 'search_web',
              arguments: '{"query":"popular AI frameworks"}',
            },
          },
        ],
      },
      { content: 'Found: LangChain, WeaveIntel, LlamaIndex are popular AI frameworks.', toolCalls: [] },
    ],
  });

  const writerModel = createFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [
          {
            id: 'wc_2',
            function: {
              name: 'write_document',
              arguments: '{"notes":"Popular AI frameworks: LangChain, WeaveIntel, LlamaIndex"}',
            },
          },
        ],
      },
      { content: 'Report written successfully.', toolCalls: [] },
    ],
  });

  const supervisor = createSupervisor({
    model: supervisorModel,
    bus,
    workers: [
      {
        name: 'researcher',
        description: 'Searches the web and gathers information',
        model: researcherModel,
        tools: researchTools,
      },
      {
        name: 'writer',
        description: 'Writes documents and reports from notes',
        model: writerModel,
        tools: writerTools,
      },
    ],
    maxSteps: 10,
  });

  const result = await supervisor.run(
    {
      messages: [
        {
          role: 'user',
          content: 'Research popular AI frameworks and write a brief report about them.',
        },
      ],
    },
    ctx,
  );

  console.log('=== Supervisor Result ===');
  console.log('Output:', result.output);
  console.log(`\nTotal steps: ${result.steps.length}`);
  for (const step of result.steps) {
    console.log(`  [${step.action}] → ${step.observation?.slice(0, 80)}...`);
  }
}

main().catch(console.error);
