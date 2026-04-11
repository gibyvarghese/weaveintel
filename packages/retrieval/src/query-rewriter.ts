/**
 * Query rewriter — rewrites queries using an LLM for better retrieval
 */
import type { ExecutionContext, Model, RetrievalQuery } from '@weaveintel/core';

export interface QueryRewriterConfig {
  model: Model;
  systemPrompt?: string;
  maxRewrites?: number;
}

const DEFAULT_SYSTEM = `You are a query expansion assistant. Given a user search query, generate improved versions that will find more relevant results. Output ONLY the rewritten queries, one per line. No explanations.`;

export function weaveQueryRewriter(config: QueryRewriterConfig) {
  const maxRewrites = config.maxRewrites ?? 3;

  return {
    async rewrite(ctx: ExecutionContext, query: RetrievalQuery): Promise<string[]> {
      const resp = await config.model.generate(ctx, {
        messages: [
          { role: 'system', content: config.systemPrompt ?? DEFAULT_SYSTEM },
          { role: 'user', content: `Rewrite this query ${maxRewrites} ways:\n"${query.query}"` },
        ],
      });
      const text = resp.content ?? '';
      const lines = text.split('\n').map((l: string) => l.replace(/^\d+[\.\)]\s*/, '').trim()).filter(Boolean);
      return [query.query, ...lines.slice(0, maxRewrites)];
    },
  };
}

export type QueryRewriter = ReturnType<typeof weaveQueryRewriter>;
