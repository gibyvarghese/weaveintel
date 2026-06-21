/**
 * @weaveintel/guardrails — evaluators/llm-judge.ts  (W2)
 *
 * LLM-as-judge async evaluator. Sends the input to a `Model` with a
 * configurable rubric prompt and parses a structured JSON verdict.
 *
 * Expected model response (JSON object on a single line or wrapped in ```json):
 *   { "decision": "allow"|"warn"|"deny", "confidence": 0–1, "rationale": "..." }
 *
 * If the model response is malformed AND the guardrail is blocking (action
 * defaults to 'deny'), fails closed. If advisory (action='warn'), falls back
 * to 'warn' with error recorded in metadata.
 *
 * config shape:
 *   rubric?:    string   — system prompt describing what the judge looks for
 *   criteria?:  string   — additional user-visible criteria appended to the rubric
 *   action?:    'deny'|'warn'  — default decision when model says 'deny' (default: 'deny')
 *   on_error?:  'deny'|'warn'|'allow'  — decision on parse/model failure (default: 'deny')
 */
import type { AsyncGuardrailContext, Guardrail, GuardrailDecision, GuardrailResult } from '@weaveintel/core';

const DEFAULT_RUBRIC = `You are a content safety judge. Evaluate the following text and output a JSON object with exactly these fields:
- "decision": one of "allow", "warn", or "deny"
- "confidence": a number between 0 and 1 indicating your certainty
- "rationale": a brief explanation (one sentence)

Output ONLY the JSON object, no other text.`;

interface JudgeVerdict {
  decision: GuardrailDecision;
  confidence: number;
  rationale: string;
}

function parseVerdict(raw: string): JudgeVerdict | null {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  // Try the whole response, then try to extract a JSON object
  const candidates = [cleaned, ...Array.from(cleaned.matchAll(/\{[^{}]+\}/g), m => m[0] ?? '')];
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as Record<string, unknown>;
      const decision = obj['decision'];
      const confidence = obj['confidence'];
      const rationale = obj['rationale'];
      if (
        (decision === 'allow' || decision === 'warn' || decision === 'deny') &&
        typeof confidence === 'number' &&
        typeof rationale === 'string'
      ) {
        return { decision, confidence, rationale };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function createLlmJudgeEvaluator(overrideRubric?: string) {
  return async function llmJudgeEvaluator(
    guardrail: Guardrail,
    input: string,
    ctx: AsyncGuardrailContext,
  ): Promise<GuardrailResult> {
    if (!ctx.model) {
      return {
        decision: 'allow',
        guardrailId: guardrail.id,
        explanation: 'No LLM provided — skipping llm-judge check',
        metadata: { skipped: 'no_model' },
      };
    }

    const rubric = overrideRubric
      ?? (typeof guardrail.config['rubric'] === 'string' ? guardrail.config['rubric'] : DEFAULT_RUBRIC);
    const criteria = typeof guardrail.config['criteria'] === 'string' ? guardrail.config['criteria'] : '';
    const rawOnError = guardrail.config['on_error'];
    const onError: GuardrailDecision =
      rawOnError === 'warn' || rawOnError === 'allow' ? rawOnError : 'deny';

    const systemPrompt = criteria ? `${rubric}\n\nAdditional criteria: ${criteria}` : rubric;

    let response: Awaited<ReturnType<typeof ctx.model.generate>>;
    try {
      response = await ctx.model.generate(
        {} as Parameters<typeof ctx.model.generate>[0],
        {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: input },
          ],
          responseFormat: { type: 'json_object' },
          temperature: 0,
          maxTokens: 256,
        },
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        decision: onError,
        guardrailId: guardrail.id,
        explanation: `llm-judge model call failed (${onError}): ${errMsg.slice(0, 200)}`,
        metadata: { callError: true, error: errMsg.slice(0, 500) },
      };
    }

    const verdict = parseVerdict(response.content);

    if (!verdict) {
      return {
        decision: onError,
        guardrailId: guardrail.id,
        explanation: `llm-judge returned unparseable response: ${response.content.slice(0, 120)}`,
        metadata: {
          rawResponse: response.content.slice(0, 500),
          parseError: true,
          inputTokens: response.usage.promptTokens,
          outputTokens: response.usage.completionTokens,
        },
      };
    }

    return {
      decision: verdict.decision,
      guardrailId: guardrail.id,
      explanation: verdict.rationale,
      confidence: verdict.confidence,
      metadata: {
        rationale: verdict.rationale,
        inputTokens: response.usage.promptTokens,
        outputTokens: response.usage.completionTokens,
      },
    };
  };
}
