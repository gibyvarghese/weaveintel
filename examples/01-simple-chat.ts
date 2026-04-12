/**
 * Example 01: Simple Chat
 *
 * Demonstrates basic model invocation with the OpenAI provider.
 * Shows request/response, streaming, and structured output.
 *
 * WeaveIntel packages used:
 *   @weaveintel/core            — ExecutionContext & EventBus (the two runtime primitives every call needs)
 *   @weaveintel/provider-openai — Thin adapter that wraps the OpenAI Chat Completions API
 *                                 behind weaveIntel's unified Model interface
 */
import { weaveContext, weaveEventBus } from '@weaveintel/core';
import { weaveOpenAIModel } from '@weaveintel/provider-openai';

async function main() {
  // weaveEventBus() creates an in-process publish/subscribe bus.
  // All weaveIntel subsystems (agents, models, middleware) emit events here
  // so you can observe, log, or react to anything that happens.
  const bus = weaveEventBus();

  // weaveContext() creates an ExecutionContext — a bag of metadata (userId,
  // traceId, custom tags) that flows through every weaveIntel call, enabling
  // per-request tracing, auth gating, and multi-tenant isolation.
  const ctx = weaveContext({ userId: 'demo-user' });

  // weaveOpenAIModel() returns an object that implements weaveIntel's Model
  // interface (chat / stream / generate / countTokens). Under the hood it
  // calls the OpenAI REST API. You can swap this for weaveAnthropicModel()
  // or any other provider without changing downstream code.
  const model = weaveOpenAIModel('gpt-4o-mini', {
    apiKey: process.env['OPENAI_API_KEY']!,
  });

  // --- Basic completion ---
  // model.chat() sends a single request and waits for the full response.
  // It returns a ChatResponse with .content (string), .usage (token counts),
  // and optional .toolCalls. The second argument is the ExecutionContext that
  // carries tracing / user info through the call stack.
  console.log('=== Basic Completion ===');
  const response = await model.generate(ctx, {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is the capital of France?' },
    ],
  });
  console.log('Response:', response.content);
  // .usage includes prompt_tokens, completion_tokens, and total_tokens — useful
  // for cost tracking via @weaveintel/observability's weaveUsageTracker.
  console.log('Usage:', response.usage);

  // --- Streaming ---
  // model.stream() returns an AsyncIterable of StreamChunk objects.
  // Each chunk has a .type — 'content' for text deltas, 'tool_call'
  // for incremental tool-call JSON, and 'done' when the stream ends.
  // Streaming lets you display tokens to the user in real time.
  console.log('\n=== Streaming ===');
  const stream = model.stream!(ctx, {
    messages: [
      { role: 'user', content: 'Count from 1 to 5, one per line.' },
    ],
  });

  process.stdout.write('Streamed: ');
  for await (const chunk of stream) {
    // Only print text deltas; ignore tool_call / done chunks here.
    if (chunk.type === 'text' && chunk.text) {
      process.stdout.write(chunk.text);
    }
  }
  console.log('\n');

  // --- Structured output ---
  // Passing responseFormat with type 'json_schema' tells the model to guarantee
  // its response matches the given JSON Schema. The weaveIntel Model interface
  // translates this to the provider-specific mechanism (e.g. OpenAI's
  // response_format.json_schema). The result is always a valid JSON string
  // in response.content that you can safely JSON.parse.
  console.log('=== Structured Output ===');
  const structured = await model.generate(ctx, {
    messages: [
      { role: 'user', content: 'List 3 European capitals as JSON: { "capitals": ["..."] }' },
    ],
    responseFormat: {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          capitals: { type: 'array', items: { type: 'string' } },
        },
        required: ['capitals'],
      },
    },
  });
  console.log('Structured:', JSON.parse(structured.content));
}

main().catch(console.error);
