/**
 * @weaveintel/guardrails — guardrail.ts
 * Built-in guardrail implementations: regex, blocklist, length, schema, custom
 */
import type { Guardrail, GuardrailDecision, GuardrailEvaluationContext, GuardrailResult, GuardrailStage, RiskLevel } from '@weaveintel/core';
import { createConfidenceGate } from './confidence-gate.js';

export interface GuardrailCategorySummary {
  confidence: number;
  decision: GuardrailDecision;
  checks: GuardrailResult[];
  riskLevel?: RiskLevel;
}

/** Evaluate a single guardrail against input text. */
export function evaluateGuardrail(
  guardrail: Guardrail,
  input: unknown,
  _stage: GuardrailStage,
  context?: GuardrailEvaluationContext,
): GuardrailResult {
  if (!guardrail.enabled) {
    return { decision: 'allow', guardrailId: guardrail.id, explanation: 'Guardrail disabled' };
  }

  const text = typeof input === 'string' ? input : JSON.stringify(input);

  switch (guardrail.type) {
    case 'regex':
      return evaluateRegex(guardrail, text);
    case 'blocklist':
      return evaluateBlocklist(guardrail, text);
    case 'length':
      return evaluateLength(guardrail, text);
    case 'schema':
      return evaluateSchema(guardrail, input);
    case 'custom':
      return evaluateCustom(guardrail, text, context);
    case 'model-graded':
      // Model-graded guardrails require async model call; return allow as placeholder
      return { decision: 'allow', guardrailId: guardrail.id, explanation: 'Model-graded guardrails require async evaluation' };
    default:
      return { decision: 'allow', guardrailId: guardrail.id, explanation: `Unknown guardrail type: ${guardrail.type}` };
  }
}

function evaluateRegex(g: Guardrail, text: string): GuardrailResult {
  const pattern = g.config['pattern'] as string | undefined;
  const action = (g.config['action'] as 'deny' | 'warn') ?? 'deny';
  if (!pattern) return { decision: 'allow', guardrailId: g.id, explanation: 'No regex pattern configured' };

  try {
    const flags = (g.config['flags'] as string) ?? 'i';
    const re = new RegExp(pattern, flags);
    if (re.test(text)) {
      return { decision: action, guardrailId: g.id, explanation: `Matched regex pattern: ${pattern}` };
    }
    return { decision: 'allow', guardrailId: g.id };
  } catch {
    return { decision: 'allow', guardrailId: g.id, explanation: `Invalid regex: ${pattern}` };
  }
}

function evaluateBlocklist(g: Guardrail, text: string): GuardrailResult {
  const words = g.config['words'] as string[] | undefined;
  const action = (g.config['action'] as 'deny' | 'warn') ?? 'deny';
  if (!words?.length) return { decision: 'allow', guardrailId: g.id, explanation: 'No blocklist words configured' };

  const lower = text.toLowerCase();
  const matched = words.filter(w => lower.includes(w.toLowerCase()));
  if (matched.length > 0) {
    return { decision: action, guardrailId: g.id, explanation: `Blocked words found: ${matched.join(', ')}` };
  }
  return { decision: 'allow', guardrailId: g.id };
}

function evaluateLength(g: Guardrail, text: string): GuardrailResult {
  const maxLength = g.config['maxLength'] as number | undefined;
  const minLength = g.config['minLength'] as number | undefined;
  const action = (g.config['action'] as 'deny' | 'warn') ?? 'warn';

  if (maxLength !== undefined && text.length > maxLength) {
    return { decision: action, guardrailId: g.id, explanation: `Input exceeds max length (${text.length} > ${maxLength})` };
  }
  if (minLength !== undefined && text.length < minLength) {
    return { decision: action, guardrailId: g.id, explanation: `Input below min length (${text.length} < ${minLength})` };
  }
  return { decision: 'allow', guardrailId: g.id };
}

function evaluateSchema(g: Guardrail, input: unknown): GuardrailResult {
  const requiredFields = g.config['requiredFields'] as string[] | undefined;
  const action = (g.config['action'] as 'deny' | 'warn') ?? 'deny';

  if (!requiredFields?.length) return { decision: 'allow', guardrailId: g.id };

  if (typeof input !== 'object' || input === null) {
    return { decision: action, guardrailId: g.id, explanation: 'Input is not an object' };
  }

  const missing = requiredFields.filter(f => !(f in (input as Record<string, unknown>)));
  if (missing.length > 0) {
    return { decision: action, guardrailId: g.id, explanation: `Missing required fields: ${missing.join(', ')}` };
  }
  return { decision: 'allow', guardrailId: g.id };
}

function evaluateCustom(g: Guardrail, text: string, context?: GuardrailEvaluationContext): GuardrailResult {
  const rule = typeof g.config['rule'] === 'string' ? g.config['rule'].trim().toLowerCase() : '';
  switch (rule) {
    case 'input-pattern':
      return evaluatePatternRule(g, String(context?.userInput ?? text), g.config['pattern_target'] === 'output' ? 'output' : 'input');
    case 'output-pattern':
      return evaluatePatternRule(g, String(context?.assistantOutput ?? text), 'output');
    case 'risk-confidence-gate':
      return evaluateRiskConfidenceGate(g, context);
    case 'grounding-overlap':
      return evaluateGroundingOverlap(g, context);
    case 'decision-balance':
      return evaluateDecisionBalance(g, context);
    case 'aggregate-confidence-gate':
      return evaluateAggregateConfidenceGate(g, context);
    default:
      break;
  }

  // Generic custom rules fall back to simple string-match rule set.
  const rules = g.config['rules'] as Array<{ match: string; decision: 'allow' | 'deny' | 'warn' }> | undefined;
  if (!rules?.length) return { decision: 'allow', guardrailId: g.id };

  for (const rule of rules) {
    if (text.toLowerCase().includes(rule.match.toLowerCase())) {
      return { decision: rule.decision, guardrailId: g.id, explanation: `Custom rule matched: "${rule.match}"` };
    }
  }
  return { decision: 'allow', guardrailId: g.id };
}

function evaluatePatternRule(g: Guardrail, text: string, target: 'input' | 'output'): GuardrailResult {
  const pattern = typeof g.config['pattern'] === 'string' ? g.config['pattern'] : undefined;
  if (!pattern) return buildResult(g, 'allow', `No pattern configured for ${target} pattern rule.`);

  const re = compileRegex(pattern);
  if (!re) return buildResult(g, 'allow', `Invalid pattern configured for ${target} pattern rule.`);

  const matched = re.test(text);
  const warnConfidence = getNumber(g.config, 'warn_confidence', 0.62);
  const allowConfidence = getNumber(g.config, 'allow_confidence', 0.86);
  const explanation = matched
    ? target === 'input'
      ? 'Prompt indicates possible agreement pressure; prioritize truth over agreement.'
      : 'Potentially overly validating phrasing detected; ensure evidence-based reasoning.'
    : target === 'input'
      ? 'No strong agreement pressure detected in prompt.'
      : 'No strong validating phrasing detected in output.';

  return buildResult(g, matched ? 'warn' : 'allow', explanation, matched ? warnConfidence : allowConfidence, { target });
}

function evaluateRiskConfidenceGate(g: Guardrail, context?: GuardrailEvaluationContext): GuardrailResult {
  const action = String(context?.action ?? context?.userInput ?? '');
  const resolved = classifyRisk(action);

  const confidence = resolved.level === 'critical'
    ? getNumber(g.config, 'critical_risk_confidence', 0.5)
    : resolved.level === 'high'
      ? getNumber(g.config, 'high_risk_confidence', 0.6)
      : resolved.level === 'medium'
        ? getNumber(g.config, 'medium_risk_confidence', 0.72)
        : getNumber(g.config, 'low_risk_confidence', 0.82);

  const gate = createConfidenceGate(
    getNumber(g.config, 'gate_threshold', 0.65),
    getGateAction(g.config, 'warn'),
  );
  const decision = gate.evaluate(confidence);
  return buildResult(
    g,
    decision,
    `Risk-aware confidence gate scored ${Math.round(confidence * 100)}% with risk=${resolved.level}.`,
    confidence,
    { riskLevel: resolved.level, riskExplanation: resolved.explanation },
  );
}

function evaluateGroundingOverlap(g: Guardrail, context?: GuardrailEvaluationContext): GuardrailResult {
  const overlap = lexicalOverlap(String(context?.userInput ?? ''), String(context?.assistantOutput ?? ''));
  const minOverlap = getNumber(g.config, 'min_overlap', 0.06);
  const decision: GuardrailDecision = overlap < minOverlap ? 'warn' : 'allow';
  return buildResult(
    g,
    decision,
    decision === 'warn'
      ? 'Low grounding overlap with the source request. Add references, assumptions, or explicit uncertainty.'
      : 'Grounding overlap looks acceptable.',
    Math.max(0.1, Math.min(1, overlap)),
    { overlap },
  );
}

function evaluateDecisionBalance(g: Guardrail, context?: GuardrailEvaluationContext): GuardrailResult {
  const userInput = String(context?.userInput ?? '');
  const assistantOutput = String(context?.assistantOutput ?? '');
  const needsPattern = compileRegex(String(g.config['needs_pattern'] ?? '\\b(should i|is it good|best|recommend|decision|choose|strategy|plan)\\b'));
  const hasPattern = compileRegex(String(g.config['has_pattern'] ?? '\\b(however|on the other hand|trade-?off|counterpoint|risk|alternative)\\b'));
  const needsCounterpoint = needsPattern?.test(userInput) ?? false;
  const hasCounterpoint = hasPattern?.test(assistantOutput) ?? false;
  const decision: GuardrailDecision = needsCounterpoint && !hasCounterpoint ? 'warn' : 'allow';
  return buildResult(
    g,
    decision,
    decision === 'warn'
      ? 'Decision-style request is missing counterpoints or trade-offs.'
      : 'Counterpoint coverage looks sufficient for the request.',
    decision === 'warn' ? getNumber(g.config, 'warn_confidence', 0.6) : getNumber(g.config, 'allow_confidence', 0.84),
    { needsCounterpoint, hasCounterpoint },
  );
}

function evaluateAggregateConfidenceGate(g: Guardrail, context?: GuardrailEvaluationContext): GuardrailResult {
  const previousChecks = (context?.previousResults ?? []).filter((result: GuardrailResult) => result.metadata?.['category'] === getCategory(g));
  const baseConfidence = previousChecks.length
    ? previousChecks.reduce((sum: number, check: GuardrailResult) => sum + (check.confidence ?? 0.75), 0) / previousChecks.length
    : getNumber(g.config, 'base_confidence', 0.75);
  const riskLevel = getRiskLevel(previousChecks) ?? 'low';
  const riskPenalty = riskLevel === 'critical' ? 0.18 : riskLevel === 'high' ? 0.12 : riskLevel === 'medium' ? 0.06 : 0;
  const confidence = Math.max(0.05, Math.min(0.99, baseConfidence - riskPenalty));
  const gate = createConfidenceGate(
    getNumber(g.config, 'gate_threshold', 0.67),
    getGateAction(g.config, 'warn'),
  );
  const decision = gate.evaluate(confidence);
  return buildResult(
    g,
    decision,
    `Aggregate confidence ${Math.round(confidence * 100)}% (risk=${riskLevel}).`,
    confidence,
    { riskLevel },
  );
}

function compileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function lexicalOverlap(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const aa = new Set(norm(a));
  const bb = new Set(norm(b));
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  aa.forEach(token => {
    if (bb.has(token)) intersection += 1;
  });
  const union = aa.size + bb.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function getCategory(g: Guardrail): string {
  return typeof g.config['category'] === 'string' && g.config['category'].trim()
    ? g.config['category'].trim()
    : 'general';
}

function getNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function getGateAction(config: Record<string, unknown>, fallback: 'warn' | 'block' | 'escalate' | 'log'): 'warn' | 'block' | 'escalate' | 'log' {
  const value = config['gate_on_fail'];
  return value === 'warn' || value === 'block' || value === 'escalate' || value === 'log' ? value : fallback;
}

function getRiskLevel(results: GuardrailResult[]): RiskLevel | undefined {
  for (const result of results) {
    const riskLevel = result.metadata?.['riskLevel'];
    if (riskLevel === 'low' || riskLevel === 'medium' || riskLevel === 'high' || riskLevel === 'critical') {
      return riskLevel;
    }
  }
  return undefined;
}

function classifyRisk(action: string): { level: RiskLevel; explanation: string } {
  const lower = action.toLowerCase();
  const rules: Array<{ pattern: RegExp; level: RiskLevel; explanation: string }> = [
    { pattern: /delete|drop|truncate|destroy|remove all/i, level: 'critical', explanation: 'Destructive operation detected' },
    { pattern: /modify|update|alter|change|overwrite/i, level: 'high', explanation: 'Modification operation detected' },
    { pattern: /create|insert|add|write/i, level: 'medium', explanation: 'Write operation detected' },
    { pattern: /read|get|list|fetch|query|select/i, level: 'low', explanation: 'Read-only operation' },
  ];

  for (const rule of rules) {
    if (rule.pattern.test(lower)) {
      return { level: rule.level, explanation: rule.explanation };
    }
  }

  return { level: 'low', explanation: 'No risk rules matched — default low risk' };
}

function buildResult(
  guardrail: Guardrail,
  decision: GuardrailDecision,
  explanation: string,
  confidence?: number,
  metadata?: Record<string, unknown>,
): GuardrailResult {
  return {
    decision,
    guardrailId: guardrail.id,
    explanation,
    confidence,
    metadata: {
      category: getCategory(guardrail),
      rule: guardrail.config['rule'],
      ...metadata,
    },
  };
}

export function summarizeGuardrailResults(results: GuardrailResult[], category?: string): GuardrailCategorySummary | null {
  const checks = category
    ? results.filter(result => result.metadata?.['category'] === category)
    : [...results];
  if (checks.length === 0) return null;

  const decision: GuardrailDecision = checks.some(check => check.decision === 'deny')
    ? 'deny'
    : checks.some(check => check.decision === 'warn')
      ? 'warn'
      : 'allow';
  const confidence = checks.reduce((sum, check) => sum + (check.confidence ?? 0.75), 0) / checks.length;

  return {
    confidence: Number(confidence.toFixed(3)),
    decision,
    checks,
    riskLevel: getRiskLevel(checks),
  };
}
