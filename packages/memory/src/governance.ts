/**
 * @weaveintel/memory — Memory governance
 *
 * Governance policies that control what data may be stored in memory,
 * enforce retention limits, and apply transformations before persistence.
 */

import type { MemoryEntry, MemoryPolicy, MemoryRetentionPolicy, ExecutionContext } from '@weaveintel/core';

/** Configuration for a governance rule. */
export interface GovernanceRule {
  id: string;
  name: string;
  /** Memory types this rule applies to */
  types?: string[];
  /** Tenant scope — undefined means global */
  tenantId?: string;
  /** Block storage if pattern matches content */
  blockPatterns?: string[];
  /** Redact matching patterns before storage */
  redactPatterns?: string[];
  /** Maximum age for entries matching this rule */
  maxAge?: string;
  /** Maximum entries for this scope */
  maxEntries?: number;
  enabled: boolean;
}

/** Create a MemoryPolicy from a set of governance rules. */
export function weaveGovernancePolicy(rules: GovernanceRule[]): MemoryPolicy {
  const enabledRules = rules.filter((r) => r.enabled);

  function applicableRules(entry: MemoryEntry): GovernanceRule[] {
    return enabledRules.filter((r) => {
      if (r.types && r.types.length > 0 && !r.types.includes(entry.type)) return false;
      if (r.tenantId && entry.tenantId && r.tenantId !== entry.tenantId) return false;
      return true;
    });
  }

  return {
    async shouldStore(_ctx: ExecutionContext, entry: MemoryEntry): Promise<boolean> {
      for (const rule of applicableRules(entry)) {
        if (rule.blockPatterns) {
          for (const pattern of rule.blockPatterns) {
            if (new RegExp(pattern, 'i').test(entry.content)) {
              return false;
            }
          }
        }
      }
      return true;
    },

    async beforeStore(_ctx: ExecutionContext, entry: MemoryEntry): Promise<MemoryEntry> {
      let content = entry.content;
      for (const rule of applicableRules(entry)) {
        if (rule.redactPatterns) {
          for (const pattern of rule.redactPatterns) {
            content = content.replace(new RegExp(pattern, 'gi'), '[REDACTED]');
          }
        }
      }
      if (content !== entry.content) {
        return { ...entry, content };
      }
      return entry;
    },

    retentionPolicy: deriveRetentionPolicy(enabledRules),
  };
}

function deriveRetentionPolicy(rules: GovernanceRule[]): MemoryRetentionPolicy | undefined {
  let minAge: string | undefined;
  let minEntries: number | undefined;

  for (const r of rules) {
    if (r.maxAge && (!minAge || r.maxAge < minAge)) minAge = r.maxAge;
    if (r.maxEntries && (!minEntries || r.maxEntries < minEntries)) minEntries = r.maxEntries;
  }

  if (!minAge && !minEntries) return undefined;

  return {
    maxAge: minAge,
    maxEntries: minEntries,
    compactionStrategy: 'drop_oldest',
  };
}
