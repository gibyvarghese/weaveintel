/**
 * @weaveintel/guardrails — streaming.ts  (W5)
 *
 * Incremental output screening for streamed model responses. Runs cheap
 * sync guardrails (blocklist, regex) over a growing buffer as chunks arrive
 * and signals halt when a `deny` is produced. Warn decisions pass through.
 *
 * This does NOT replace the terminal `checkOutput` call in the agent loop —
 * both run. This only allows early halt (before generation completes) for
 * deterministic rules. Expensive model-graded checks belong in `checkOutput`.
 *
 * Usage:
 *   const guard = createStreamingGuardrail({ guardrails, stage: 'post-execution' });
 *   for await (const chunk of stream) {
 *     const { halt, reason } = await guard.checkChunk(chunk.text ?? '');
 *     if (halt) { abortController.abort(); break; }
 *     yield chunk;
 *   }
 *   // Terminal check still runs via agent loop's checkOutput.
 */
import type { Guardrail, GuardrailResult, GuardrailStage } from '@weaveintel/core';
import { evaluateGuardrail } from './guardrail.js';

export interface StreamingGuardrailOptions {
  /** Guardrails to run on each buffer flush. Only sync types (blocklist, regex) are effective here. */
  readonly guardrails: readonly Guardrail[];
  /**
   * Minimum characters to accumulate before checking (reduces per-chunk overhead).
   * Default: 50 chars. Set 0 to check every chunk.
   */
  readonly minBufferSize?: number;
  /** Pipeline stage to evaluate against. Default: 'post-execution'. */
  readonly stage?: GuardrailStage;
}

export interface StreamCheckResult {
  /** True if the stream should be halted. */
  readonly halt: boolean;
  /** The guardrail explanation that triggered the halt, if any. */
  readonly reason?: string;
  /** All results from this evaluation pass. */
  readonly results?: readonly GuardrailResult[];
}

export interface StreamGuardrailHandle {
  /**
   * Check a new chunk. Internally accumulates chunks and evaluates the buffer
   * when it reaches `minBufferSize`. Returns `{ halt: false }` until a deny fires.
   */
  checkChunk(chunk: string): StreamCheckResult;
  /**
   * Force evaluation of any remaining buffered content. Call after the stream ends
   * (or before the terminal `checkOutput`) to flush any leftover buffer.
   */
  flush(): StreamCheckResult;
  /** Current accumulated buffer (read-only). */
  readonly buffer: string;
}

export function createStreamingGuardrail(opts: StreamingGuardrailOptions): StreamGuardrailHandle {
  const { guardrails, minBufferSize = 50, stage = 'post-execution' } = opts;

  // Only sync-evaluatable types are useful here — filter to the ones that
  // actually do string matching so model-graded guardrails don't silently no-op.
  const syncTypes = new Set<string>(['regex', 'blocklist', 'length', 'custom']);
  const applicableGuardrails = guardrails.filter(
    g => g.enabled && g.stage === stage && syncTypes.has(g.type),
  );

  let accumulated = '';
  let lastCheckedLen = 0;
  let halted = false;
  let haltReason: string | undefined;

  function evaluateBuffer(text: string): StreamCheckResult {
    if (applicableGuardrails.length === 0) return { halt: false };

    const results: GuardrailResult[] = [];
    for (const guardrail of applicableGuardrails) {
      const r = evaluateGuardrail(guardrail, text, stage);
      results.push(r);
      if (r.decision === 'deny') {
        return { halt: true, reason: r.explanation, results };
      }
    }
    return { halt: false, results };
  }

  return {
    get buffer() { return accumulated; },

    checkChunk(chunk: string): StreamCheckResult {
      if (halted) return { halt: true, reason: haltReason };

      accumulated += chunk;
      const newLen = accumulated.length;

      // Only re-evaluate when enough new content has arrived.
      if (newLen - lastCheckedLen < minBufferSize) return { halt: false };

      lastCheckedLen = newLen;
      const result = evaluateBuffer(accumulated);
      if (result.halt) {
        halted = true;
        haltReason = result.reason;
      }
      return result;
    },

    flush(): StreamCheckResult {
      if (halted) return { halt: true, reason: haltReason };

      const result = evaluateBuffer(accumulated);
      if (result.halt) {
        halted = true;
        haltReason = result.reason;
      }
      return result;
    },
  };
}
