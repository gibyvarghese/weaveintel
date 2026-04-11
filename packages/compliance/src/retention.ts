// @weaveintel/compliance — Data retention rules

export type RetentionAction = 'delete' | 'archive' | 'anonymize';

export interface RetentionRule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly dataCategory: string;
  readonly retentionDays: number;
  readonly action: RetentionAction;
  readonly enabled: boolean;
  readonly createdAt: number;
}

export interface RetentionEngine {
  addRule(rule: Omit<RetentionRule, 'createdAt'>): RetentionRule;
  getRule(id: string): RetentionRule | undefined;
  listRules(): readonly RetentionRule[];
  removeRule(id: string): boolean;
  evaluate(dataCategory: string, createdAt: number): RetentionAction | null;
}

export function createRetentionEngine(): RetentionEngine {
  const rules = new Map<string, RetentionRule>();

  return {
    addRule(rule) {
      const r: RetentionRule = { ...rule, createdAt: Date.now() };
      rules.set(r.id, r);
      return r;
    },
    getRule(id) { return rules.get(id); },
    listRules() { return Array.from(rules.values()); },
    removeRule(id) { return rules.delete(id); },
    evaluate(dataCategory, createdAt) {
      const now = Date.now();
      for (const rule of rules.values()) {
        if (!rule.enabled) continue;
        if (rule.dataCategory !== dataCategory && rule.dataCategory !== '*') continue;
        const ageMs = now - createdAt;
        if (ageMs > rule.retentionDays * 86_400_000) return rule.action;
      }
      return null;
    },
  };
}
