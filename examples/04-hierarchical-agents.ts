/**
 * Example 04: Hierarchical Agents
 *
 * Demonstrates a supervisor agent that delegates tasks to specialized workers.
 * The supervisor decides which worker to route each sub-task to.
 *
 * WeaveIntel packages used:
 *   @weaveintel/core    — ExecutionContext, EventBus, ToolRegistry, weaveTool()
 *   @weaveintel/agents  — weaveSupervisor() builds a multi-agent hierarchy where one
 *                         "boss" model delegates sub-tasks to named worker agents
 *   @weaveintel/testing — weaveFakeModel() provides deterministic model responses
 *
 * Architecture:
 *   Supervisor (with delegate_to_worker tool)
 *     ├─ researcher  — has search_web tool
 *     └─ writer      — has write_document tool
 */
import {
  weaveContext,
  weaveEventBus,
  weaveToolRegistry,
  weaveTool,
} from '@weaveintel/core';
import { weaveSupervisor } from '@weaveintel/agents';
import { weaveFakeModel } from '@weaveintel/testing';

async function main() {
  const bus = weaveEventBus();
  const ctx = weaveContext({ userId: 'demo-user' });

  // Each worker has its own ToolRegistry with domain-specific tools.
  // The supervisor doesn't see these tools directly — it delegates to a worker
  // by name, and the worker's own agent loop handles tool execution internally.
  const researchTools = weaveToolRegistry();
  researchTools.register(
    weaveTool({
      name: 'search_web',
      description: 'Search the web for information',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      execute: async (args) =>
        `Results for "${(args as { query: string }).query}": AI frameworks include LangChain, weaveIntel, LlamaIndex.`,
    }),
  );

  const writerTools = weaveToolRegistry();
  writerTools.register(
    weaveTool({
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

  // The supervisor's model is configured with a sequence of fake responses:
  //   1. Delegates to 'researcher' via the built-in 'delegate_to_worker' tool
  //   2. Delegates to 'writer' with the research results
  //   3. Produces a final summary (no tool calls → loop ends)
  // In production the supervisor model would be a real LLM that decides
  // which worker to call based on the conversation and task decomposition.
  const supervisorModel = weaveFakeModel({
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
                goal: 'Search for popular AI frameworks',
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
                goal: 'Write a brief summary about AI frameworks',
              }),
            },
          },
        ],
      },
      // Step 3: supervisor produces final answer
      {
        content: 'The research team found that popular AI frameworks include LangChain, weaveIntel, and LlamaIndex. A report has been generated.',
        toolCalls: [],
      },
    ],
  });

  // Worker models
  const researcherModel = weaveFakeModel({
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
      { content: 'Found: LangChain, weaveIntel, LlamaIndex are popular AI frameworks.', toolCalls: [] },
    ],
  });

  const writerModel = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [
          {
            id: 'wc_2',
            function: {
              name: 'write_document',
              arguments: '{"notes":"Popular AI frameworks: LangChain, weaveIntel, LlamaIndex"}',
            },
          },
        ],
      },
      { content: 'Report written successfully.', toolCalls: [] },
    ],
  });

  // weaveSupervisor() creates a hierarchical agent system:
  //   • It auto-injects a 'delegate_to_worker' tool into the supervisor's tool set
  //   • When the supervisor calls that tool, its loop pauses, spins up the named
  //     worker agent, runs it to completion, and returns the worker's output
  //     as the tool result to the supervisor.
  //   • Each worker is a full weaveAgent with its own model + tools + maxSteps.
  //   • maxSteps on the supervisor limits the total number of delegation rounds.
  const supervisor = weaveSupervisor({
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
    maxSteps: 10, // Max delegation rounds for the supervisor
  });

  const result = await supervisor.run(
    ctx,
    {
      messages: [
        {
          role: 'user',
          content: 'Research popular AI frameworks and write a brief report about them.',
        },
      ],
    },
  );

  console.log('=== Supervisor Result ===');
  console.log('Output:', result.output);
  console.log(`\nTotal steps: ${result.steps.length}`);
  for (const step of result.steps) {
    console.log(`  [${step.type}] → ${(step.content ?? step.toolCall?.name ?? '')?.slice(0, 80)}...`);
  }
}

main().catch(console.error);
