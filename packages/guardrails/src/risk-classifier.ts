/**
 * @weaveintel/guardrails — risk-classifier.ts
 * Action risk scoring based on configurable rules
 */
import type { RiskLevel, RiskClassifier as IRiskClassifier } from '@weaveintel/core';

export interface RiskRule {
  pattern: string;
  level: RiskLevel;
  explanation: string;
}

const DEFAULT_RULES: RiskRule[] = [
  { pattern: 'delete|drop|truncate|destroy|remove all', level: 'critical', explanation: 'Destructive operation detected' },
  { pattern: 'modify|update|alter|change|overwrite', level: 'high', explanation: 'Modification operation detected' },
  { pattern: 'create|insert|add|write', level: 'medium', explanation: 'Write operation detected' },
  { pattern: 'read|get|list|fetch|query|select', level: 'low', explanation: 'Read-only operation' },
];

export class DefaultRiskClassifier implements IRiskClassifier {
  private rules: RiskRule[];

  constructor(rules?: RiskRule[]) {
    this.rules = rules ?? DEFAULT_RULES;
  }

  async classify(action: string, _context?: Record<string, unknown>): Promise<{ level: RiskLevel; explanation: string }> {
    const lower = action.toLowerCase();

    for (const rule of this.rules) {
      try {
        const re = new RegExp(rule.pattern, 'i');
        if (re.test(lower)) {
          return { level: rule.level, explanation: rule.explanation };
        }
      } catch {
        continue;
      }
    }

    return { level: 'low', explanation: 'No risk rules matched — default low risk' };
  }

  addRule(rule: RiskRule): void {
    this.rules.unshift(rule);
  }
}

export function createRiskClassifier(rules?: RiskRule[]): DefaultRiskClassifier {
  return new DefaultRiskClassifier(rules);
}
