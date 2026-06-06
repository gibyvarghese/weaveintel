/**
 * @weaveintel/guardrails — evaluators/semantic-grounding.ts  (W3)
 *
 * Embedding-based grounding check. Embeds the assistant output and the
 * available evidence (toolEvidence, userInput), then computes cosine
 * similarity. Warns when similarity falls below `config.min_similarity`.
 *
 * Falls back to the lexical `grounding-overlap` rule when no `EmbeddingModel`
 * is provided (preserves current behaviour). The tool-evidence short-circuit
 * ("grounded by definition when tool calls are present") still applies.
 *
 * config shape:
 *   min_similarity?: number   — cosine similarity threshold (default: 0.50)
 *   evidence_field?:          — which context field to use as reference:
 *                               'toolEvidence' | 'userInput' | 'both' (default: 'both')
 */
import type { AsyncGuardrailContext, Guardrail, GuardrailResult } from '@weaveintel/core';

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0, normA = 0, normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function createSemanticGroundingEvaluator() {
  return async function semanticGroundingEvaluator(
    guardrail: Guardrail,
    _input: string,
    ctx: AsyncGuardrailContext,
  ): Promise<GuardrailResult> {
    // Tool-grounded short-circuit — same as the lexical rule.
    if (ctx.toolEvidence?.trim()) {
      return {
        decision: 'allow',
        guardrailId: guardrail.id,
        explanation: 'Response is grounded via tool evidence (semantic check bypassed).',
        confidence: 0.95,
        metadata: { toolGrounded: true },
      };
    }

    if (!ctx.embeddingModel) {
      // No embedder — fall through to allow; callers should ensure the
      // lexical grounding-overlap rule is also enabled as a fallback.
      return {
        decision: 'allow',
        guardrailId: guardrail.id,
        explanation: 'No embedding model provided — semantic grounding check skipped',
        metadata: { skipped: 'no_embedding_model' },
      };
    }

    const output = ctx.assistantOutput ?? '';
    const evidenceField = typeof guardrail.config['evidence_field'] === 'string'
      ? guardrail.config['evidence_field'] : 'both';
    const minSimilarity = typeof guardrail.config['min_similarity'] === 'number'
      ? guardrail.config['min_similarity'] : 0.50;

    const referenceText = evidenceField === 'toolEvidence'
      ? (ctx.toolEvidence ?? ctx.userInput ?? '')
      : evidenceField === 'userInput'
        ? (ctx.userInput ?? '')
        : `${ctx.userInput ?? ''} ${ctx.toolEvidence ?? ''}`.trim();

    if (!output || !referenceText) {
      return {
        decision: 'allow',
        guardrailId: guardrail.id,
        explanation: 'Insufficient context for semantic grounding check',
        metadata: { skipped: 'insufficient_context' },
      };
    }

    const fakeCtx = {} as Parameters<typeof ctx.embeddingModel.embed>[0];
    const embedResponse = await ctx.embeddingModel.embed(fakeCtx, {
      input: [output, referenceText],
    });

    const [outputEmb, referenceEmb] = embedResponse.embeddings;
    if (!outputEmb || !referenceEmb) {
      return {
        decision: 'allow',
        guardrailId: guardrail.id,
        explanation: 'Embedding returned insufficient vectors',
        metadata: { skipped: 'embedding_error' },
      };
    }

    const similarity = cosineSimilarity(outputEmb, referenceEmb);
    const decision = similarity < minSimilarity ? 'warn' : 'allow';

    return {
      decision,
      guardrailId: guardrail.id,
      explanation: decision === 'warn'
        ? `Low semantic similarity with source (${similarity.toFixed(3)} < ${minSimilarity}). Response may not be grounded in the evidence.`
        : `Semantic similarity acceptable (${similarity.toFixed(3)} ≥ ${minSimilarity}).`,
      confidence: similarity,
      metadata: { similarity, minSimilarity, tokensUsed: embedResponse.usage.totalTokens },
    };
  };
}
