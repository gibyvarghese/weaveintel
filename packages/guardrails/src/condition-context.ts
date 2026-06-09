/**
 * @weaveintel/guardrails — condition-context.ts
 *
 * Signal extraction and context structure for guardrail conditional triggers.
 * All extraction is purely regex/string-based — no I/O, no LLM calls.
 * Target: < 1ms per extraction on a 2000-char message.
 */

export interface InputSignals {
  length: number;
  hasCode: boolean;
  hasUrls: boolean;
  hasBase64: boolean;
  hasStructuredData: boolean;
  hasDecisionLanguage: boolean;
  hasValidationSeeking: boolean;
  hasFactualQuestion: boolean;
  hasInstructionOverride: boolean;
  hasSensitivePattern: boolean;
}

export interface OutputSignals {
  length: number;
  hasCodeBlocks: boolean;
  hasFactualClaims: boolean;
  hasAdvice: boolean;
  hasCredentialPatterns: boolean;
  hasToolEvidence: boolean;
  hasUrls: boolean;
}

export interface GuardrailConditionContext {
  user: {
    /** platform_admin / tenant_admin / tenant_user / anonymous */
    persona: string;
    /** First session or fewer than N prior messages */
    isNew: boolean;
  };
  chat: {
    /** direct / agent / supervisor */
    mode: string;
  };
  turn: {
    /** Number of messages in this conversation */
    number: number;
    hasToolCalls: boolean;
    /** Which tool classes ran: cse, web_search, api, file, external */
    toolCategories: string[];
  };
  risk: {
    /** low / medium / high / critical */
    level: string;
    /** read / write / modify / destructive */
    verb: string;
  };
  prior: {
    /** Any guardrail already warned this pipeline run */
    hasWarn: boolean;
    /** Cognitive checks specifically warned */
    hasCognitiveWarn: boolean;
    /** An injection check warned on the input */
    hasInjectionWarn: boolean;
  };
  input: InputSignals;
  /** null during pre-stage; populated for post-stage */
  output: OutputSignals | null;
}

// ── Input signal patterns ──────────────────────────────────────────────────
// Kept module-level so they compile once and are reused across calls.

const RE_INPUT_CODE = /`{1,3}[^`]*`{1,3}|```[\s\S]*?```/;
const RE_INPUT_URLS = /https?:\/\/[^\s<>"']+|(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/i;
// 30+ consecutive base64 chars not immediately preceded by word chars (avoids
// triggering on long hex IDs that are common in structured JSON payloads).
const RE_INPUT_BASE64 = /(?<![A-Za-z0-9])[A-Za-z0-9+/]{30,}={0,2}(?![A-Za-z0-9])/;
const RE_INPUT_STRUCTURED = /^\s*[{[<]|<\/?[a-zA-Z][^>]*>|"[^"]+"\s*:|\b(?:true|false|null)\b,/m;
const RE_DECISION_LANGUAGE = /\bshould\s+I\b|\brecommend(?:ation)?\b|\bbest\s+option\b|\bwhat(?:'s|'s|\s+is)\s+better\b|\badvise\b|\bwhat\s+should\b/i;
const RE_VALIDATION_SEEKING = /\bright\?|don'?t\s+you\s+think|\bagree\?|\bisn'?t\s+it\?|\bcorrect\?|\bmakes?\s+sense\?|wouldn'?t\s+you\s+say/i;
const RE_FACTUAL_QUESTION = /\bwh(?:at|en|ere|o|ose)\b|\bhow\s+(?:many|much|long|often|far)\b/i;
const RE_INSTRUCTION_OVERRIDE = /ignore\s+(?:previous|prior|all|your|the)\s+(?:instructions?|rules?|prompt|context)|new\s+rule[:\s]|pretend\s+you\s+are\b|your\s+instructions\b/i;
const RE_SENSITIVE_INPUT =
  /\b\d{3}-\d{2}-\d{4}\b|(?:\d[ -]?){13,16}|(?:sk-|AIza|AKIA|ya29\.)[A-Za-z0-9_\-]{10,}|(?:postgres(?:ql)?|mysql|mongodb):\/\/[^\s]+/i;

export function buildInputSignals(input: string): InputSignals {
  return {
    length: input.length,
    hasCode: RE_INPUT_CODE.test(input),
    hasUrls: RE_INPUT_URLS.test(input),
    hasBase64: RE_INPUT_BASE64.test(input),
    hasStructuredData: RE_INPUT_STRUCTURED.test(input),
    hasDecisionLanguage: RE_DECISION_LANGUAGE.test(input),
    hasValidationSeeking: RE_VALIDATION_SEEKING.test(input),
    hasFactualQuestion: RE_FACTUAL_QUESTION.test(input),
    hasInstructionOverride: RE_INSTRUCTION_OVERRIDE.test(input),
    hasSensitivePattern: RE_SENSITIVE_INPUT.test(input),
  };
}

// ── Output signal patterns ─────────────────────────────────────────────────

const RE_OUTPUT_CODE_BLOCK = /```[\s\S]*?```/;
const RE_FACTUAL_CLAIMS =
  /\b\d{4}\b|\b\d+(?:\.\d+)?%|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b|\b\d+(?:\.\d+)?\s*(?:million|billion|thousand)\b/i;
const RE_ADVICE = /\bshould\b|\brecommend\b|\bsuggests?\b|\badvises?\b|\byou\s+(?:could|might|may|can)\b|\bconsider\b|\bbest\s+practice\b/i;
const RE_CREDENTIAL_OUTPUT =
  /(?:sk-|AIza|AKIA|ya29\.)[A-Za-z0-9_\-]{10,}|(?:password|secret|token|api[_\-]?key)\s*[:=]\s*\S{8,}/i;
const RE_OUTPUT_URLS = /https?:\/\/[^\s<>"']+/;

export function buildOutputSignals(output: string, toolEvidence: boolean): OutputSignals {
  return {
    length: output.length,
    hasCodeBlocks: RE_OUTPUT_CODE_BLOCK.test(output),
    hasFactualClaims: RE_FACTUAL_CLAIMS.test(output),
    hasAdvice: RE_ADVICE.test(output),
    hasCredentialPatterns: RE_CREDENTIAL_OUTPUT.test(output),
    hasToolEvidence: toolEvidence,
    hasUrls: RE_OUTPUT_URLS.test(output),
  };
}
