/**
 * Example 163: Multi-tier evaluation pipeline (P6-1)
 *
 * Demonstrates chaining schema-check → rubric critic → verifier → ensemble
 * as a configurable evaluation cascade that runs after agent response generation.
 *
 * The pipeline attaches a structured report to AgentResult.metadata.evalPipeline
 * so callers can inspect which stages passed/failed and at what score.
 */

import { weaveAgent } from '@weaveintel/agents';
import type { Critic, CritiqueResult, Verifier, VerifyResult, ExecutionContext } from '@weaveintel/core';

// --- Build stub model ---

import type { Model } from '@weaveintel/core';

const model: Model = {
  async generate(_ctx, req) {
    const lastMsg = req.messages.at(-1);
    const content = typeof lastMsg?.content === 'string' ? lastMsg.content : '';
    if (content.includes('JSON')) {
      return {
        content: JSON.stringify({ summary: 'Paris is the capital of France.', confidence: 0.97 }),
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 15, totalTokens: 25 },
      };
    }
    return {
      content: 'Paris is the capital of France, known for its art, culture, and gastronomy.',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    };
  },
};

// --- Build critic: checks response quality ---

const rubricCritic: Critic = {
  async critique(_ctx: ExecutionContext, _input: string, draft: string): Promise<CritiqueResult> {
    const wordCount = draft.split(/\s+/).length;
    if (wordCount < 5) {
      return { accepted: false, score: 0.2, feedback: 'Response is too short — please elaborate.' };
    }
    return { accepted: true, score: 0.9 };
  },
};

// --- Build verifier: checks for factual markers ---

const factVerifier: Verifier = {
  async verify(_ctx: ExecutionContext, output: string): Promise<VerifyResult> {
    const hasCapitalMention = /capital/i.test(output) || /Paris/i.test(output);
    if (!hasCapitalMention) {
      return { passed: false, score: 0.1, reason: 'Response does not mention the capital city.' };
    }
    return { passed: true, score: 1.0 };
  },
};

// --- Schema-only agent: validates JSON output ---

const schemaAgent = weaveAgent({
  name: 'schema-agent',
  model,
  evalPipeline: {
    stages: [
      {
        type: 'schema',
        schema: {
          type: 'object',
          required: ['summary', 'confidence'],
          properties: {
            summary:    { type: 'string' },
            confidence: { type: 'number' },
          },
        },
        blockOnFailure: true,
      },
    ],
  },
});

// --- Full pipeline: schema → reflect → verify ---

const fullPipelineAgent = weaveAgent({
  name: 'full-pipeline-agent',
  model,
  evalPipeline: {
    stages: [
      {
        type: 'reflect',
        critic: rubricCritic,
        minScore: 0.7,
        maxRevisions: 1,
      },
      {
        type: 'verify',
        verifier: factVerifier,
        maxAttempts: 2,
      },
    ],
    failFast: true,
  },
});

async function main(): Promise<void> {
  const ctx = { userId: 'demo', sessionId: 'eval-pipeline-demo' } as ExecutionContext;

  // 1) Run schema-validated agent
  console.log('=== Schema Validation Pipeline ===');
  const schemaResult = await schemaAgent.run(ctx, {
    messages: [{ role: 'user', content: 'Tell me about France in JSON format please.' }],
  });
  const schemaPipeline = schemaResult.metadata?.['evalPipeline'] as {
    accepted: boolean;
    stages: Array<{ stage: string; accepted: boolean; errors?: string[] }>;
    overallScore: number;
  } | undefined;
  console.log('Output:', schemaResult.output);
  console.log('Pipeline accepted:', schemaPipeline?.accepted);
  console.log('Schema errors:', schemaPipeline?.stages[0]?.errors ?? []);

  // 2) Run full pipeline
  console.log('\n=== Full Evaluation Pipeline ===');
  const fullResult = await fullPipelineAgent.run(ctx, {
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
  });
  const fullPipeline = fullResult.metadata?.['evalPipeline'] as {
    accepted: boolean;
    overallScore: number;
    revisions: number;
    verifyAttempts: number;
    stages: Array<{ stage: string; accepted: boolean; score?: number; reason?: string }>;
    evaluatedAt: string;
  } | undefined;
  console.log('Output:', fullResult.output);
  console.log('Pipeline accepted:', fullPipeline?.accepted);
  console.log('Overall score:', fullPipeline?.overallScore.toFixed(2));
  console.log('Stages:', fullPipeline?.stages.map((s) => `${s.stage}(${s.accepted ? '✓' : '✗'})`).join(' → '));
  console.log('Revisions:', fullPipeline?.revisions, '| Verify attempts:', fullPipeline?.verifyAttempts);
  console.log('Evaluated at:', fullPipeline?.evaluatedAt);
}

main().catch(console.error);
