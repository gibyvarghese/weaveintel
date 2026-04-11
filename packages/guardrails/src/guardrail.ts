/**
 * @weaveintel/guardrails — guardrail.ts
 * Built-in guardrail implementations: regex, blocklist, length, schema, custom
 */
import type { Guardrail, GuardrailResult, GuardrailStage } from '@weaveintel/core';

/** Evaluate a single guardrail against input text. */
export function evaluateGuardrail(guardrail: Guardrail, input: unknown, _stage: GuardrailStage): GuardrailResult {
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
      return evaluateCustom(guardrail, text);
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

function evaluateCustom(g: Guardrail, text: string): GuardrailResult {
  // Custom guardrails use config.evaluate as a simple string-match rule set
  const rules = g.config['rules'] as Array<{ match: string; decision: 'allow' | 'deny' | 'warn' }> | undefined;
  if (!rules?.length) return { decision: 'allow', guardrailId: g.id };

  for (const rule of rules) {
    if (text.toLowerCase().includes(rule.match.toLowerCase())) {
      return { decision: rule.decision, guardrailId: g.id, explanation: `Custom rule matched: "${rule.match}"` };
    }
  }
  return { decision: 'allow', guardrailId: g.id };
}
