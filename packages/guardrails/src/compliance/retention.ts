// @weaveintel/guardrails/compliance — Data retention rules

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
  /**
   * H-7: Evaluation priority — higher value = evaluated first.
   *
   * Without a priority field `evaluate()` returns the first matching rule in
   * insertion order. A broad `dataCategory: '*'` rule added before a specific
   * one permanently shadows the specific rule, silently applying the wrong
   * retention policy to regulated data.
   *
   * Convention (mirrors iptables / firewall semantics):
   *  - 100  category-specific rules (highest — evaluated first)
   *  - 50   region/tenant-scoped catch-alls
   *  - 0    global wildcard default (lowest — evaluated last)
   *
   * Defaults to 0 when omitted so existing rules keep their current order
   * relative to each other (all at the same priority level).
   */
  readonly priority: number;
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
      const r: RetentionRule = {
        ...rule,
        // H-7: Default priority to 0 so callers that do not set it explicitly
        // get the old first-match behaviour relative to each other, but can be
        // overridden by any rule that sets a positive priority.
        // Placed after spread so `rule.priority` takes precedence when provided.
        priority: rule.priority ?? 0,
        createdAt: Date.now(),
      };
      rules.set(r.id, r);
      return r;
    },
    getRule(id) { return rules.get(id); },
    listRules() { return Array.from(rules.values()); },
    removeRule(id) { return rules.delete(id); },
    evaluate(dataCategory, createdAt) {
      const now = Date.now();

      // H-7: Sort by priority descending so high-priority (specific) rules are
      // checked before low-priority (wildcard) rules. Stable sort preserves
      // insertion order within the same priority tier.
      const sorted = [...rules.values()].sort((a, b) => b.priority - a.priority);

      for (const rule of sorted) {
        if (!rule.enabled) continue;
        if (rule.dataCategory !== dataCategory && rule.dataCategory !== '*') continue;
        const ageMs = now - createdAt;
        if (ageMs > rule.retentionDays * 86_400_000) return rule.action;
      }
      return null;
    },
  };
}
