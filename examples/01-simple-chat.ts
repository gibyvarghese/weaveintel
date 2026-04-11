/**
 * Example 01: Simple Chat
 * 
 * Demonstrates basic model invocation with the OpenAI provider.
 * Shows request/response, streaming, and structured output.
 */
import { weaveContext, weaveEventBus } from '@weaveintel/core';
import { weaveOpenAIModel } from '@weaveintel/provider-openai';

async function main() {
  const bus = weaveEventBus();
  const ctx = weaveContext({ userId: 'demo-user' });

  // Create a model instance
  const model = weaveOpenAIModel({
    apiKey: process.env['OPENAI_API_KEY']!,
    model: 'gpt-4o-mini',
  });

  // --- Basic completion ---
  console.log('=== Basic Completion ===');
  const response = await model.chat(
    {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is the capital of France?' },
      ],
    },
    ctx,
  );
  console.log('Response:', response.content);
  console.log('Usage:', response.usage);

  // --- Streaming ---
  console.log('\n=== Streaming ===');
  const stream = await model.stream(
    {
      messages: [
        { role: 'user', content: 'Count from 1 to 5, one per line.' },
      ],
    },
    ctx,
  );

  process.stdout.write('Streamed: ');
  for await (const chunk of stream) {
    if (chunk.type === 'content') {
      process.stdout.write(chunk.content);
    }
  }
  console.log('\n');

  // --- Structured output ---
  console.log('=== Structured Output ===');
  const structured = await model.chat(
    {
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
    },
    ctx,
  );
  console.log('Structured:', JSON.parse(structured.content));
}

main().catch(console.error);
