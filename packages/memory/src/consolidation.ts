/**
 * @weaveintel/memory — Consolidation pipeline
 *
 * Runs on the cold path (session-end or cron) to distil ephemeral episodic
 * entries into durable semantic facts.
 *
 * Pipeline:
 *   1. Load recent unconsolidated episodic entries for a user/session
 *   2. For each entry, run extraction (regex + optional LLM) to pull facts
 *   3. Score each fact with a salience heuristic → importance
 *   4. Dedup across extracted facts (keep highest confidence)
 *   5. Stamp provenance on every fact
 *   6. Write facts to the semantic store
 *   7. Mark source episodic entries as consolidated so they aren't re-processed
 */

import type {
  ExecutionContext,
  MemoryEntry,
  MemoryStore,
  MemoryConsolidator,
  ConsolidationInput,
  ConsolidationResult,
} from '@weaveintel/core';
import { deduplicateByKey } from './dedup.js';
import { withProvenance } from './provenance.js';
import { runHybridMemoryExtraction, type MemoryExtractionRule, type LlmEntityExtractor } from './extraction.js';

export interface MemoryConsolidatorOptions {
  /** Source store: read unconsolidated episodic entries from here. */
  episodicStore: MemoryStore;
  /** Target store: write consolidated semantic facts here. */
  semanticStore: MemoryStore;
  /**
   * Optional LLM-based fact extractor. Called for each episodic entry to
   * extract structured facts the regex rules may miss. The callable should
   * return an array of { content, confidence, metadata? } objects.
   *
   * Use the cost-governor's model cascade (small / cheap model) for this;
   * the consolidator is a background process, not on the hot path.
   */
  llmExtractor?: (ctx: ExecutionContext, text: string) => Promise<Array<{
    content: string;
    confidence: number;
    metadata?: Record<string, unknown>;
  }>>;
  /** Regex extraction rules — shared with the hot-path extraction pipeline. */
  extractionRules?: MemoryExtractionRule[];
  /** Raw LLM entity extractor used by runHybridMemoryExtraction. */
  llmEntityExtractor?: LlmEntityExtractor;
  /** Minimum confidence (0–1) to retain an extracted fact. Defaults to 0.6. */
  minConfidence?: number;
  /**
   * Source tag written into each fact's provenance and metadata so operators
   * can distinguish consolidation-derived facts from user-direct writes.
   * Defaults to 'consolidation'.
   */
  sourceTag?: string;
}

/** Heuristic importance score (0–1) for a candidate fact string. */
function scoreImportance(content: string, source: 'user' | 'extraction' | 'llm'): number {
  let score = 0.4;

  // Length signal: brief specific facts score higher than one-word blurbs
  const words = content.trim().split(/\s+/).length;
  if (words >= 5 && words <= 60) score += 0.15;
  if (words > 60) score -= 0.05;

  // Source signal: direct user statements are more reliable
  if (source === 'user') score += 0.2;
  if (source === 'llm') score += 0.1;

  // Content signal: proper nouns, numbers, and named entities suggest specificity
  if (/[A-Z][a-z]+/.test(content)) score += 0.1;
  if (/\d/.test(content)) score += 0.05;

  return Math.min(1.0, Math.max(0.0, score));
}

export function weaveMemoryConsolidator(opts: MemoryConsolidatorOptions): MemoryConsolidator {
  const {
    episodicStore,
    semanticStore,
    llmExtractor,
    extractionRules = [],
    llmEntityExtractor,
    minConfidence = 0.6,
    sourceTag = 'consolidation',
  } = opts;

  return {
    async consolidate(ctx: ExecutionContext, input: ConsolidationInput): Promise<ConsolidationResult> {
      const errors: string[] = [];
      const batchSize = input.batchSize ?? 50;

      // ── 1. Load unconsolidated episodic entries ──────────────────────────
      let episodic: MemoryEntry[] = [];
      try {
        episodic = await episodicStore.query(ctx, {
          type: 'episodic',
          topK: batchSize,
          filter: {
            userId: input.userId,
            sessionId: input.sessionId,
            tenantId: input.tenantId,
          },
        });
        // Skip already-consolidated entries
        episodic = episodic.filter((e) => !e.metadata['_consolidated']);
      } catch (err) {
        errors.push(`episodic load failed: ${String(err)}`);
        return { episodicRead: 0, factsExtracted: 0, factsDeduped: 0, factsWritten: 0, errors };
      }

      if (episodic.length === 0) {
        return { episodicRead: 0, factsExtracted: 0, factsDeduped: 0, factsWritten: 0, errors };
      }

      // ── 2. Extract facts from each entry ────────────────────────────────
      const candidateFacts: Array<{
        content: string;
        confidence: number;
        source: 'user' | 'extraction' | 'llm';
        metadata: Record<string, unknown>;
        sourceEntryId: string;
      }> = [];

      for (const entry of episodic) {
        const text = entry.content;

        // Regex + LLM entity extraction via existing pipeline
        if (extractionRules.length > 0 || llmEntityExtractor) {
          try {
            const extraction = await runHybridMemoryExtraction({
              ctx,
              input: { userContent: text },
              rules: extractionRules,
              llmExtractor: llmEntityExtractor,
            });
            for (const entity of extraction.entities) {
              if (entity.confidence < minConfidence) continue;
              candidateFacts.push({
                content: `${entity.type}: ${entity.name}${Object.keys(entity.facts).length ? ' — ' + JSON.stringify(entity.facts) : ''}`,
                confidence: entity.confidence,
                source: entity.source === 'llm' ? 'llm' : 'extraction',
                metadata: { entity_type: entity.type, entity_name: entity.name, ...entity.facts },
                sourceEntryId: entry.id,
              });
            }
          } catch (err) {
            errors.push(`extraction failed for ${entry.id}: ${String(err)}`);
          }
        }

        // Optional free-text LLM fact extractor (richer, model-driven)
        if (llmExtractor) {
          try {
            const llmFacts = await llmExtractor(ctx, text);
            for (const fact of llmFacts) {
              if (fact.confidence < minConfidence) continue;
              candidateFacts.push({
                content: fact.content,
                confidence: fact.confidence,
                source: 'llm',
                metadata: fact.metadata ?? {},
                sourceEntryId: entry.id,
              });
            }
          } catch (err) {
            errors.push(`LLM extractor failed for ${entry.id}: ${String(err)}`);
          }
        }

        // If no extractor configured, treat the whole episodic entry as a candidate fact
        if (extractionRules.length === 0 && !llmEntityExtractor && !llmExtractor) {
          candidateFacts.push({
            content: text.slice(0, 600),
            confidence: 0.7,
            source: 'user',
            metadata: {},
            sourceEntryId: entry.id,
          });
        }
      }

      const factsExtracted = candidateFacts.length;

      // ── 3. Build MemoryEntry candidates ─────────────────────────────────
      const now = new Date().toISOString();
      const rawEntries: MemoryEntry[] = candidateFacts.map((fact, i) => ({
        id: `consolidated:${fact.sourceEntryId}:${i}:${Date.now()}`,
        type: 'semantic' as const,
        content: fact.content,
        metadata: {
          ...fact.metadata,
          _consolidatedFrom: fact.sourceEntryId,
          _sourceTag: sourceTag,
          _confidence: fact.confidence,
        },
        createdAt: now,
        validAt: now,
        importance: scoreImportance(fact.content, fact.source),
        userId: input.userId,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
      }));

      // ── 4. Dedup: keep highest-importance entry per normalised content ───
      const deduped = deduplicateByKey(
        rawEntries,
        (e) => e.content.toLowerCase().replace(/\s+/g, ' ').slice(0, 120),
        'keep_highest_score',
      );
      const factsDeduped = factsExtracted - deduped.length;

      // ── 5. Stamp provenance ──────────────────────────────────────────────
      const toWrite = deduped.map((entry) =>
        withProvenance(entry, {
          source: sourceTag,
          confidence: (entry.metadata['_confidence'] as number | undefined) ?? 0.7,
          extractedBy: 'weaveMemoryConsolidator',
          createdAt: now,
        }),
      );

      // ── 6. Write to semantic store ───────────────────────────────────────
      let factsWritten = 0;
      if (toWrite.length > 0) {
        try {
          await semanticStore.write(ctx, toWrite);
          factsWritten = toWrite.length;
        } catch (err) {
          errors.push(`semantic write failed: ${String(err)}`);
        }
      }

      // ── 7. Mark source episodic entries as consolidated ──────────────────
      if (factsWritten > 0) {
        const consolidated = episodic.map((e) => ({
          ...e,
          metadata: { ...e.metadata, _consolidated: true, _consolidatedAt: now },
        }));
        try {
          await episodicStore.write(ctx, consolidated);
        } catch (err) {
          errors.push(`marking consolidated failed: ${String(err)}`);
        }
      }

      return {
        episodicRead: episodic.length,
        factsExtracted,
        factsDeduped,
        factsWritten,
        errors,
      };
    },
  };
}
