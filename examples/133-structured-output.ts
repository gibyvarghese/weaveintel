/**
 * Example 133 — Structured output with JSON schema validation (P2-2)
 *
 * Demonstrates how to configure weaveAgent to produce structured JSON output
 * conforming to a schema.  The agent validates the response, retries once if
 * the JSON is invalid or missing required fields, and surfaces the parsed
 * object in AgentResult.metadata.structuredOutput.
 *
 * Usage:
 *   npx ts-node examples/133-structured-output.ts
 */

import { weaveContext, weaveRuntime } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { createMockModel } from '@weaveintel/devtools';

// ── Schema ────────────────────────────────────────────────────────────────────

const analysisSchema = {
  type: 'json_schema' as const,
  name: 'sentiment_analysis',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      sentiment:   { type: 'string', enum: ['positive', 'neutral', 'negative'] },
      confidence:  { type: 'number', minimum: 0, maximum: 1 },
      summary:     { type: 'string' },
      keywords:    { type: 'array', items: { type: 'string' } },
    },
    required: ['sentiment', 'confidence', 'summary', 'keywords'],
    additionalProperties: false,
  },
};

// ── Scenario A: model returns valid JSON on first try ─────────────────────────

const goodModel = createMockModel({
  name: 'structured-demo',
  responses: [
    JSON.stringify({
      sentiment: 'positive',
      confidence: 0.92,
      summary: 'The review expresses strong satisfaction with the product.',
      keywords: ['excellent', 'fast', 'reliable'],
    }),
  ],
});

// ── Scenario B: model first returns unstructured text, then valid JSON ─────────

let callB = 0;
const recoveryModel = createMockModel({ name: 'recovery-demo', responses: ['ok'] });
const originalGenerate = recoveryModel.generate.bind(recoveryModel);
(recoveryModel as typeof recoveryModel & { generate: typeof recoveryModel.generate }).generate = async (ctx, req) => {
  callB++;
  if (callB === 1) {
    // First attempt: plain English (invalid JSON for the schema)
    return {
      id: 'b1', model: 'recovery-demo', content: 'This is a positive review.',
      toolCalls: [], finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }
  // After retry nudge: valid JSON
  return {
    id: 'b2', model: 'recovery-demo',
    content: JSON.stringify({
      sentiment: 'positive', confidence: 0.85,
      summary: 'Positive review recovered on retry.',
      keywords: ['good', 'quality'],
    }),
    toolCalls: [], finishReason: 'stop',
    usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50 },
  };
};

// ── Setup ─────────────────────────────────────────────────────────────────────

const runtime = weaveRuntime({ audit: { async log() {} } });
const ctx = weaveContext({ runtime });

const input = {
  messages: [{
    role: 'user' as const,
    content: 'Analyse the sentiment of: "This product is excellent! Fast shipping and very reliable."',
  }],
};

// ── Run scenario A ────────────────────────────────────────────────────────────

console.log('=== Scenario A: Valid JSON on first try ===');
const agentA = weaveAgent({
  model: goodModel,
  name: 'structured-agent-a',
  outputSchema: analysisSchema,
});
const resultA = await agentA.run(ctx, input);
console.log('Status:', resultA.status);
console.log('Structured output:', JSON.stringify(resultA.metadata?.structuredOutput, null, 2));

// ── Run scenario B ────────────────────────────────────────────────────────────

console.log('\n=== Scenario B: Invalid JSON → retry → success ===');
const agentB = weaveAgent({
  model: recoveryModel,
  name: 'structured-agent-b',
  outputSchema: analysisSchema,
  structuredOutputRetries: 1,
});
const resultB = await agentB.run(ctx, input);
console.log('Status:', resultB.status);
console.log('Structured output:', JSON.stringify(resultB.metadata?.structuredOutput, null, 2));
console.log(`Model calls needed: ${callB} (1 invalid + 1 valid)`);
