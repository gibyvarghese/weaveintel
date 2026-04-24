/**
 * Example 04: Hierarchical Agents
 *
 * Demonstrates a supervisor agent that delegates tasks to specialized workers.
 * The supervisor decides which worker to route each sub-task to.
 *
 * Required environment variables:
 *   OPENAI_API_KEY — Your OpenAI API key
 *
 * WeaveIntel packages used:
 *   @weaveintel/core          — ExecutionContext, EventBus, ToolRegistry, weaveTool()
 *   @weaveintel/agents        — weaveSupervisor() builds a multi-agent hierarchy where one
 *                               "boss" model delegates sub-tasks to named worker agents
 *   @weaveintel/provider-openai — weaveOpenAIModel() for real model inference
 *
 * Architecture:
 *   Supervisor (with delegate_to_worker tool)
 *     ├─ researcher  — has search_web tool
 *     └─ writer      — has write_document tool
 */
import 'dotenv/config';
import {
  weaveContext,
  weaveEventBus,
  weaveToolRegistry,
  weaveTool,
} from '@weaveintel/core';
import { weaveSupervisor } from '@weaveintel/agents';
import { weaveOpenAIModel } from '@weaveintel/provider-openai';

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

  // The supervisor's model is configured with the OpenAI API.
  // The model will intelligently decide which worker to call based on the conversation
  // and task decomposition.
  const supervisorModel = weaveOpenAIModel('gpt-4o-mini', {
    apiKey: process.env['OPENAI_API_KEY'],
  });

  // Worker models — each uses the real OpenAI API
  const researcherModel = weaveOpenAIModel('gpt-4o-mini', {
    apiKey: process.env['OPENAI_API_KEY'],
  });

  const writerModel = weaveOpenAIModel('gpt-4o-mini', {
    apiKey: process.env['OPENAI_API_KEY'],
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
