/**
 * Tool-schema translator tests.
 *
 * Covers:
 *  - Forward translate snapshots for openai / anthropic / google
 *  - Behaviour parity with the legacy `buildAnthropicTools` and
 *    `buildOpenAITools` provider helpers.
 *  - parseToolCall extraction from realistic provider responses.
 *  - validate() for name regex + max count.
 *  - translateConversationHistory round-trip (Anthropic ↔ OpenAI).
 */

import { describe, it, expect } from 'vitest';
import type { Message, ToolDefinition } from '@weaveintel/core';
import {
  anthropicAdapter,
  googleAdapter,
  openaiAdapter,
  parseToolCall,
  translate,
  translateConversationHistory,
  validate,
} from './index.js';

const sampleTools: ToolDefinition[] = [
  {
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an email',
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

describe('translate — OpenAI', () => {
  it('matches legacy buildOpenAITools output shape', () => {
    const out = translate(sampleTools, openaiAdapter);
    expect(out).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city',
          parameters: sampleTools[0]!.parameters,
        },
      },
      {
        type: 'function',
        function: {
          name: 'send_email',
          description: 'Send an email',
          parameters: sampleTools[1]!.parameters,
        },
      },
    ]);
  });

  it('passes through strict flag', () => {
    const out = translate([{ ...sampleTools[0]!, strict: true }], openaiAdapter);
    expect((out[0] as Record<string, Record<string, unknown>>)['function']?.['strict']).toBe(true);
  });
});

describe('translate — Anthropic', () => {
  it('matches legacy buildAnthropicTools output shape', () => {
    const out = translate(sampleTools, anthropicAdapter);
    expect(out).toEqual([
      {
        name: 'get_weather',
        description: 'Get the current weather for a city',
        input_schema: sampleTools[0]!.parameters,
      },
      {
        name: 'send_email',
        description: 'Send an email',
        input_schema: sampleTools[1]!.parameters,
      },
    ]);
  });
});

describe('translate — Google', () => {
  it('wraps tools in a single functionDeclarations block', () => {
    const out = translate(sampleTools, googleAdapter);
    expect(out).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get the current weather for a city',
            parameters: sampleTools[0]!.parameters,
          },
          {
            name: 'send_email',
            description: 'Send an email',
            parameters: sampleTools[1]!.parameters,
          },
        ],
      },
    ]);
  });
});

describe('parseToolCall', () => {
  it('extracts OpenAI tool calls from a chat completion body', () => {
    const body = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
              },
            ],
          },
        },
      ],
    };
    const calls = parseToolCall(body, openaiAdapter);
    expect(calls).toEqual([
      { id: 'call_abc', name: 'get_weather', arguments: { city: 'Paris' } },
    ]);
  });

  it('extracts Anthropic tool_use blocks', () => {
    const body = {
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Tokyo' } },
      ],
    };
    const calls = parseToolCall(body, anthropicAdapter);
    expect(calls).toEqual([
      { id: 'toolu_1', name: 'get_weather', arguments: { city: 'Tokyo' } },
    ]);
  });

  it('extracts Google functionCall parts', () => {
    const body = {
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: 'send_email', args: { to: 'a@b.c', subject: 'hi', body: 'yo' } } },
            ],
          },
        },
      ],
    };
    const calls = parseToolCall(body, googleAdapter);
    expect(calls).toEqual([
      { id: '', name: 'send_email', arguments: { to: 'a@b.c', subject: 'hi', body: 'yo' } },
    ]);
  });

  it('returns empty array when response has no tool calls', () => {
    expect(parseToolCall({}, openaiAdapter)).toEqual([]);
    expect(parseToolCall({ content: [] }, anthropicAdapter)).toEqual([]);
    expect(parseToolCall({}, googleAdapter)).toEqual([]);
  });
});

describe('validate', () => {
  it('flags invalid tool names', () => {
    const issues = validate(
      [{ name: 'bad name!', description: '', parameters: { type: 'object' } }],
      openaiAdapter,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('name_invalid');
  });

  it('flags too many tools', () => {
    const many: ToolDefinition[] = Array.from({ length: 200 }, (_, i) => ({
      name: `tool_${i}`,
      description: '',
      parameters: { type: 'object' },
    }));
    const issues = validate(many, openaiAdapter);
    expect(issues.some((i) => i.code === 'too_many_tools')).toBe(true);
  });

  it('returns no issues for valid input', () => {
    expect(validate(sampleTools, openaiAdapter)).toEqual([]);
    expect(validate(sampleTools, anthropicAdapter)).toEqual([]);
    expect(validate(sampleTools, googleAdapter)).toEqual([]);
  });
});

describe('translateConversationHistory', () => {
  const conversation: Message[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Weather in Paris?' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' }],
    },
    { role: 'tool', content: '{"temp_c": 12}', toolCallId: 'call_1', name: 'get_weather' },
    { role: 'assistant', content: 'It is 12°C.' },
  ];

  it('keeps OpenAI conversation intact when target is OpenAI', () => {
    const out = translateConversationHistory(conversation, openaiAdapter, openaiAdapter);
    expect(out).toHaveLength(conversation.length);
    expect(out[3]!.role).toBe('tool');
    expect(out[3]!.toolCallId).toBe('call_1');
  });

  it('rewrites tool messages into Anthropic-friendly user blocks', () => {
    const out = translateConversationHistory(conversation, openaiAdapter, anthropicAdapter);
    // The tool result message is reshaped into a user message.
    const reshaped = out[3]!;
    expect(reshaped.role).toBe('user');
    const parts = reshaped.content as Array<{ type: string; text?: string }>;
    expect(parts[0]?.type).toBe('text');
    expect(parts[0]?.text).toContain('tool_result tool_use_id=call_1');
  });

  it('round-trip OpenAI → Anthropic → OpenAI preserves message count', () => {
    const a = translateConversationHistory(conversation, openaiAdapter, anthropicAdapter);
    const b = translateConversationHistory(a, anthropicAdapter, openaiAdapter);
    expect(b).toHaveLength(conversation.length);
  });
});
