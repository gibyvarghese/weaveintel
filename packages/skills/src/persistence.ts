import type { SkillDefinition, SkillExample, SkillDomainSection, SkillExecutionContract } from './types.js';
import { defineSkill } from './types.js';

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  category: string;
  trigger_patterns: string;
  instructions: string;
  tool_names: string | null;
  examples: string | null;
  tags: string | null;
  priority: number;
  version: string;
  /** Phase 6: tool policy key that overrides the global tool policy while this skill is active */
  tool_policy_key: string | null;
  /** Optional JSON array of {key,label?,content,tags?} domain-scoped sub-playbooks. */
  domain_sections?: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function safeParseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function safeParseExamples(raw: string | null | undefined): SkillExample[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const rec = item as Record<string, unknown>;
        return {
          input: String(rec['input'] ?? ''),
          output: String(rec['output'] ?? ''),
          notes: typeof rec['notes'] === 'string' ? rec['notes'] : undefined,
        };
      })
      .filter((item) => Boolean(item.input && item.output));
  } catch {
    return [];
  }
}

function safeParseDomainSections(raw: string | null | undefined): SkillDomainSection[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const rec = item as Record<string, unknown>;
        const key = typeof rec['key'] === 'string' ? rec['key'].trim() : '';
        const content = typeof rec['content'] === 'string' ? rec['content'] : '';
        if (!key || !content.trim()) return null;
        const label = typeof rec['label'] === 'string' ? rec['label'] : undefined;
        const tags = Array.isArray(rec['tags'])
          ? (rec['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
          : undefined;
        return { key, label, content, tags } as SkillDomainSection;
      })
      .filter((item): item is SkillDomainSection => item !== null);
  } catch {
    return [];
  }
}

function safeParseExecutionContract(raw: string | null | undefined): SkillExecutionContract | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const rec = parsed as Record<string, unknown>;
    const out: { -readonly [K in keyof SkillExecutionContract]: SkillExecutionContract[K] } = {};
    if (typeof rec['minDelegations'] === 'number' && Number.isFinite(rec['minDelegations'])) {
      out.minDelegations = rec['minDelegations'] as number;
    }
    if (Array.isArray(rec['requiredOutputSubstrings'])) {
      out.requiredOutputSubstrings = (rec['requiredOutputSubstrings'] as unknown[])
        .filter((s): s is string => typeof s === 'string' && s.length > 0);
    }
    if (Array.isArray(rec['requiredOutputPatterns'])) {
      out.requiredOutputPatterns = (rec['requiredOutputPatterns'] as unknown[])
        .filter((s): s is string => typeof s === 'string' && s.length > 0);
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Sentinel marker line emitted into the rendered system prompt when a
 * skill has an executionContract. The chat runtime extracts these via
 * {@link extractSkillExecutionContractsFromPrompt} and enforces them.
 *
 * Format (one per line):
 *   [SKILL_EXEC_CONTRACT skill_id=<id>] <json>
 */
export const SKILL_EXEC_CONTRACT_MARKER = '[SKILL_EXEC_CONTRACT';

export interface ResolvedSkillExecutionContract {
  readonly skillId: string;
  readonly skillName?: string;
  readonly contract: SkillExecutionContract;
}

/**
 * Extract every {@link SkillExecutionContract} embedded in a rendered
 * supervisor system prompt. Returns an empty array when no contracts
 * are present (or when the prompt is empty/undefined).
 */
export function extractSkillExecutionContractsFromPrompt(prompt: string | undefined | null): ResolvedSkillExecutionContract[] {
  if (!prompt || !prompt.includes(SKILL_EXEC_CONTRACT_MARKER)) return [];
  const out: ResolvedSkillExecutionContract[] = [];
  const lines = prompt.split('\n');
  for (const line of lines) {
    const idx = line.indexOf(SKILL_EXEC_CONTRACT_MARKER);
    if (idx < 0) continue;
    const closeIdx = line.indexOf(']', idx);
    if (closeIdx < 0) continue;
    const header = line.slice(idx + SKILL_EXEC_CONTRACT_MARKER.length, closeIdx);
    const json = line.slice(closeIdx + 1).trim();
    const skillIdMatch = /skill_id=([^\s\]]+)/.exec(header);
    const skillId = skillIdMatch?.[1] ?? 'unknown';
    const contract = safeParseExecutionContract(json);
    if (!contract) continue;
    out.push({ skillId, contract });
  }
  return out;
}

export function skillFromRow(row: SkillRow): SkillDefinition {
  const examples = safeParseExamples(row.examples);
  const tools = safeParseStringArray(row.tool_names);
  const triggerPatterns = safeParseStringArray(row.trigger_patterns);
  const tags = safeParseStringArray(row.tags);
  const domainSections = safeParseDomainSections((row as { domain_sections?: string | null }).domain_sections);
  const executionContract = safeParseExecutionContract((row as { execution_contract?: string | null }).execution_contract);

  return defineSkill({
    id: row.id,
    name: row.name,
    version: row.version,
    enabled: row.enabled !== 0,
    category: row.category,
    summary: row.description || row.instructions,
    purpose: row.description,
    executionGuidance: row.instructions,
    examples: examples.length ? examples : undefined,
    tags: tags.length ? tags : undefined,
    triggerPatterns,
    toolNames: tools,
    description: row.description,
    instructions: row.instructions,
    priority: row.priority,
    toolPolicyKey: row.tool_policy_key ?? undefined,
    policy: tools.length ? { allowedTools: tools } : undefined,
    completionContract: {
      narrative: 'Provide a complete response with evidence and surface ambiguity explicitly when confidence is low.',
      requiredEvidence: ['evidence', 'confidence'],
      ambiguityBehavior: 'Use explicit uncertainty language when context is incomplete.',
    },
    domainSections: domainSections.length ? domainSections : undefined,
    executionContract,
  });
}
