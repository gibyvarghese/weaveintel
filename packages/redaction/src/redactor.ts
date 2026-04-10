/**
 * @weaveintel/redaction — PII detection & redaction
 *
 * Regex-based PII detection with built-in patterns for common types
 * (email, phone, SSN, credit card, IP address). Supports custom patterns,
 * allowlists, and reversible tokenization.
 */

import type {
  Redactor,
  RedactionResult,
  RedactionPolicy,
  RedactionPattern,
  Detection,
  PolicyEngine,
  PolicyRule,
  PolicyInput,
  PolicyEvaluation,
  ExecutionContext,
} from '@weaveintel/core';

// ─── Built-in patterns ───────────────────────────────────────

const BUILTIN_PATTERNS: Record<string, RegExp> = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  phone: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  credit_card: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  ipv4: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
  // UUID
  uuid: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
};

// ─── Redactor implementation ─────────────────────────────────

export function createRedactor(policy: RedactionPolicy): Redactor {
  const compiledPatterns = policy.patterns.map((p) => compilePattern(p));

  return {
    async redact(_ctx: ExecutionContext, text: string): Promise<RedactionResult> {
      const detections: Detection[] = [];
      let redacted = text;

      // Collect all detections first
      for (const { pattern, type, replacement } of compiledPatterns) {
        const regex = new RegExp(pattern.source, pattern.flags);
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          const original = match[0];

          // Check allowlist
          if (policy.allowlist?.some((a) => original.includes(a))) continue;

          detections.push({
            type,
            start: match.index,
            end: match.index + original.length,
            original: policy.reversible ? original : undefined,
            token: replacement ?? `[${type.toUpperCase()}]`,
          });
        }
      }

      // Check denylist — force-redact anything matching
      if (policy.denylist) {
        for (const denied of policy.denylist) {
          let idx = text.indexOf(denied);
          while (idx !== -1) {
            detections.push({
              type: 'denylist',
              start: idx,
              end: idx + denied.length,
              original: policy.reversible ? denied : undefined,
              token: '[REDACTED]',
            });
            idx = text.indexOf(denied, idx + 1);
          }
        }
      }

      if (detections.length === 0) {
        return { redacted: text, detections: [], wasModified: false };
      }

      // Sort detections by position (reverse) to replace from end to start
      const sorted = [...detections].sort((a, b) => b.start - a.start);

      // Deduplicate overlapping detections (keep the longest)
      const deduped: Detection[] = [];
      for (const d of sorted) {
        if (deduped.length === 0 || d.end <= deduped[deduped.length - 1]!.start) {
          deduped.push(d);
        }
      }

      // Apply replacements
      for (const d of deduped) {
        redacted = redacted.slice(0, d.start) + (d.token ?? '[REDACTED]') + redacted.slice(d.end);
      }

      return {
        redacted,
        detections: deduped.reverse(),
        wasModified: true,
      };
    },

    async restore(_ctx: ExecutionContext, text: string, tokens: Detection[]): Promise<string> {
      if (!policy.reversible) {
        throw new Error('Redaction is not reversible — policy.reversible is false');
      }
      let restored = text;
      // Replace tokens with originals, in reverse order
      const sorted = [...tokens].sort((a, b) => b.start - a.start);
      for (const t of sorted) {
        if (t.original && t.token) {
          restored = restored.replace(t.token, t.original);
        }
      }
      return restored;
    },
  };
}

function compilePattern(p: RedactionPattern): { pattern: RegExp; type: string; replacement?: string } {
  if (p.type === 'builtin') {
    const builtin = BUILTIN_PATTERNS[p.builtinType ?? p.name];
    if (!builtin) {
      throw new Error(`Unknown builtin pattern: ${p.builtinType ?? p.name}`);
    }
    return { pattern: builtin, type: p.name, replacement: p.replacement };
  }
  if (p.type === 'regex' && p.pattern) {
    return { pattern: new RegExp(p.pattern, 'g'), type: p.name, replacement: p.replacement };
  }
  throw new Error(`Invalid redaction pattern: ${JSON.stringify(p)}`);
}

// ─── Policy engine implementation ────────────────────────────

export function createPolicyEngine(): PolicyEngine {
  const rules: PolicyRule[] = [];

  return {
    addRule(rule: PolicyRule): void {
      rules.push(rule);
    },

    async evaluate(ctx: ExecutionContext, input: PolicyInput): Promise<PolicyEvaluation> {
      const matchedPolicies: string[] = [];

      for (const rule of rules) {
        const result = await rule.evaluate(ctx, input);
        matchedPolicies.push(rule.name);
        if (!result.allowed) {
          return {
            allowed: false,
            reason: result.reason ?? `Blocked by policy: ${rule.name}`,
            policies: matchedPolicies,
          };
        }
      }

      return { allowed: true, policies: matchedPolicies };
    },
  };
}
