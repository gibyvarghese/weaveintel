/**
 * Example 71 — Tool Schema Translation (anyWeave Phase 3)
 *
 * Demonstrates the @weaveintel/tool-schema package:
 *
 *  1. Translate the same canonical ToolDefinition[] into OpenAI, Anthropic,
 *     and Google formats — proving one definition feeds every provider.
 *  2. Parse a sample provider response back into normalised tool calls.
 *  3. Validate tool definitions against an adapter (name regex, count).
 *  4. Translate a conversation history when the router swaps providers
 *     mid-conversation (OpenAI tool result → Anthropic-friendly user block
 *     → back to OpenAI).
 *  5. Show that the GeneWeave `provider_tool_adapters` table carries the
 *     same metadata that the runtime adapters expose (DB-driven, no code
 *     changes required to add a new provider entry).
 *
 * Run with:  npx tsx examples/71-tool-schema-translation.ts
 */

import type { Message, ToolDefinition } from '@weaveintel/core';
import {
  anthropicAdapter,
  defaultAdapterRegistry,
  googleAdapter,
  openaiAdapter,
  parseToolCall,
  translate,
  translateConversationHistory,
  validate,
} from '@weaveintel/tool-schema';

// ────────────────────────────────────────────────────────────────────────────
// Step 1 — One canonical tool definition, three provider formats
// ────────────────────────────────────────────────────────────────────────────

const tools: ToolDefinition[] = [
  {
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
        units: { type: 'string', enum: ['c', 'f'] },
      },
      required: ['city'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an email to a single recipient',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
];

console.log('═══════════════════════════════════════════════════════════════');
console.log('Step 1 — Canonical → provider-specific tool formats');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('OpenAI format:');
console.log(JSON.stringify(translate(tools, openaiAdapter), null, 2));

console.log('\nAnthropic format:');
console.log(JSON.stringify(translate(tools, anthropicAdapter), null, 2));

console.log('\nGoogle Gemini format:');
console.log(JSON.stringify(translate(tools, googleAdapter), null, 2));

// ────────────────────────────────────────────────────────────────────────────
// Step 2 — Parse provider responses back into normalised tool calls
// ────────────────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('Step 2 — Parse provider responses → normalised tool calls');
console.log('═══════════════════════════════════════════════════════════════\n');

const openaiResponse = {
  choices: [
    {
      message: {
        tool_calls: [
          {
            id: 'call_abc123',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Auckland","units":"c"}' },
          },
        ],
      },
    },
  ],
};
console.log('OpenAI →', parseToolCall(openaiResponse, openaiAdapter));

const anthropicResponse = {
  content: [
    { type: 'text', text: 'Let me check.' },
    { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Tokyo', units: 'c' } },
  ],
};
console.log('Anthropic →', parseToolCall(anthropicResponse, anthropicAdapter));

const googleResponse = {
  candidates: [
    {
      content: {
        parts: [{ functionCall: { name: 'send_email', args: { to: 'a@b.c', subject: 'hi', body: 'yo' } } }],
      },
    },
  ],
};
console.log('Google →', parseToolCall(googleResponse, googleAdapter));

// ────────────────────────────────────────────────────────────────────────────
// Step 3 — Validate tool definitions against an adapter
// ────────────────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('Step 3 — Validate against adapter constraints');
console.log('═══════════════════════════════════════════════════════════════\n');

const bad: ToolDefinition[] = [
  { name: 'has spaces!', description: '', parameters: { type: 'object' } },
];
console.log('Validation issues for invalid name:', validate(bad, openaiAdapter));
console.log('Validation issues for valid tools:  ', validate(tools, openaiAdapter));

// ────────────────────────────────────────────────────────────────────────────
// Step 4 — Translate conversation history across a provider swap
// ────────────────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('Step 4 — Translate conversation history mid-conversation');
console.log('═══════════════════════════════════════════════════════════════\n');

const conversation: Message[] = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'Weather in Auckland?' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Auckland"}' }],
  },
  { role: 'tool', content: '{"temp_c":18}', toolCallId: 'call_1', name: 'get_weather' },
  { role: 'assistant', content: 'It is 18°C in Auckland.' },
];

console.log('Original (OpenAI shape) — ' + conversation.length + ' messages');

const forAnthropic = translateConversationHistory(conversation, openaiAdapter, anthropicAdapter);
console.log('\nReshaped for Anthropic:');
console.log(JSON.stringify(forAnthropic, null, 2));

const roundTrip = translateConversationHistory(forAnthropic, anthropicAdapter, openaiAdapter);
console.log('\nRound-trip back to OpenAI — ' + roundTrip.length + ' messages (same count: ' +
  (roundTrip.length === conversation.length) + ')');

// ────────────────────────────────────────────────────────────────────────────
// Step 5 — Adapter registry (DB-driven entry point)
// ────────────────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('Step 5 — Default adapter registry');
console.log('═══════════════════════════════════════════════════════════════\n');

for (const a of defaultAdapterRegistry.list()) {
  console.log(`  ${a.provider.padEnd(10)} → ${a.displayName}`);
  console.log(`             system_prompt_location=${a.systemPromptLocation}`);
  console.log(`             max_tool_count=${a.maxToolCount}`);
  console.log(`             name_regex=${a.nameValidationRegex}`);
}

console.log('\nThe GeneWeave provider_tool_adapters table carries the same fields,');
console.log('so adding a new provider is a DB row + adapter registration — no fork required.\n');
