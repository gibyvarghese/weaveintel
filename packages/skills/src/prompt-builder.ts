import type { SkillActivationResult, SkillInvocationMode, SkillMatch } from './types.js';
import { SKILL_EXEC_CONTRACT_MARKER } from './persistence.js';
import { type PromptSection, sectionLabel, selectRelevantSections } from './matching.js';
import { collectSkillTools } from './activation.js';

export function buildSkillInvocationPrompt(
  activation: SkillActivationResult,
  mode: SkillInvocationMode,
  query?: string,
): string {
  if (!activation.selected.length) return '';

  const parts: string[] = ['## Active Skills'];

  for (const match of activation.selected) {
    const skill = match.skill;
    const sections: Array<string | undefined> = [`### ${skill.name}`];
    const candidates: PromptSection[] = [];

    const pushCandidate = (title: string, value: string | undefined, mandatory = false): void => {
      const text = value?.trim();
      if (!text) return;
      candidates.push({ title, value: text, mandatory });
    };

    pushCandidate('Summary', skill.summary, true);
    pushCandidate('Purpose', skill.purpose);
    pushCandidate('When To Use', skill.whenToUse, true);
    pushCandidate('When Not To Use', skill.whenNotToUse);

    if (mode === 'advisory' || mode === 'reasoning_support') {
      pushCandidate('Reasoning Guidance', skill.reasoningGuidance, true);
      pushCandidate('Execution Guidance', skill.executionGuidance, true);
    }

    if (mode === 'extraction' || mode === 'structured_output' || mode === 'tool_assisted' || mode === 'side_effect_eligible') {
      pushCandidate('Execution Guidance', skill.executionGuidance, true);
      pushCandidate('Required Context', skill.requiredContext);
      pushCandidate('Output Guidance', skill.outputGuidance, true);
      pushCandidate('Completion Guidance', skill.completionGuidance, true);
      pushCandidate('Ambiguity Guidance', skill.ambiguityGuidance);
      pushCandidate('Failure Guidance', skill.failureGuidance);
      if (skill.completionContract) {
        pushCandidate('Completion Contract', skill.completionContract.narrative);
      }
    }

    if (skill.domainSections?.length) {
      for (const ds of skill.domainSections) {
        const text = ds.content?.trim();
        if (!text) continue;
        const label = `Domain: ${ds.label ?? ds.key}`;
        const tagHint = ds.tags?.length ? `\n[tags: ${ds.tags.join(', ')}]` : '';
        const keyHint = `\n[domain_key: ${ds.key}]`;
        candidates.push({
          title: label,
          value: `${tagHint}${keyHint}\n${text}`.trim(),
          mandatory: false,
        });
      }
    }

    for (const selectedSection of selectRelevantSections(candidates, query, mode)) {
      sections.push(sectionLabel(selectedSection.title, selectedSection.value));
    }

    if (mode === 'tool_assisted' || mode === 'side_effect_eligible') {
      const tools = collectSkillTools([{ ...match, source: match.source }]);
      if (tools.length) {
        sections.push(`### Tool Guidance\nUse only relevant tools for this step. Candidate tools: ${tools.join(', ')}`);
      }
    }

    if (skill.examples?.length) {
      const ex = skill.examples.slice(0, 2).map((item) => `- Input: ${item.input}\n  Output: ${item.output}`).join('\n');
      sections.push(`### Examples\n${ex}`);
    }

    sections.push(sectionLabel('Selection Rationale', match.rationale));

    if (skill.executionContract) {
      const contractJson = JSON.stringify(skill.executionContract);
      sections.push(`${SKILL_EXEC_CONTRACT_MARKER} skill_id=${skill.id}] ${contractJson}`);
    }

    parts.push(...sections.filter((item): item is string => Boolean(item)));
  }

  return `${parts.join('\n\n')}\n`;
}

export function buildSkillSystemPrompt(matches: SkillMatch[]): string {
  const activation: SkillActivationResult = {
    considered: matches,
    selected: matches,
    rejected: [],
    mode: 'reasoning_support',
  };
  return buildSkillInvocationPrompt(activation, 'reasoning_support');
}

export function applySkillsToPrompt(
  basePrompt: string | undefined,
  matches: SkillMatch[],
  mode: SkillInvocationMode = 'reasoning_support',
  query?: string,
): string | undefined {
  const activation: SkillActivationResult = {
    considered: matches,
    selected: matches,
    rejected: [],
    mode,
  };
  const skillBlock = buildSkillInvocationPrompt(activation, mode, query);
  if (!skillBlock && !basePrompt) return undefined;
  if (!skillBlock) return basePrompt;
  if (!basePrompt) return skillBlock;
  return `${basePrompt.trim()}\n\n${skillBlock}`;
}
