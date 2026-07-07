// SPDX-License-Identifier: MIT
/**
 * REAL LLM end-to-end for skill evaluation → promotion.
 *
 * This closes the loop on the whole quality story with a real model:
 *   • a real model *performs* the skill on real-world inputs (runCase),
 *   • a real model *grades* whether each output actually did the job (judgeCase),
 *   • a real model *scores* the qualitative dimensions against a rubric (judge),
 *   • and the resulting evaluation drives an actual tier promotion.
 *
 * It also shows the safety property: a skill whose outputs don't do the job is failed by the judge
 * and is NOT promoted — the gate can't be passed just by having a nice description.
 *
 * Skipped when no OPENAI_API_KEY (read from env or the monorepo root .env).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defineSkill } from '../types.js';
import { evaluateSkill, evaluatePromotion, type SkillEvalCase } from '../skill-evaluation.js';

function loadKey(): string | undefined {
  if (process.env['OPENAI_API_KEY']) return process.env['OPENAI_API_KEY'];
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../../../.env', '../../../.env', '../../.env']) {
    try {
      const m = readFileSync(join(here, rel), 'utf8').match(/^OPENAI_API_KEY=(.+)$/m);
      if (m) return m[1]!.trim().replace(/^["']|["']$/g, '');
    } catch { /* keep looking */ }
  }
  return undefined;
}
const KEY = loadKey();

async function chat(model: string, system: string, user: string, json = false): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, temperature: 0,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
  return ((await res.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content;
}

const contractSkill = defineSkill({
  id: 'summarise-contract',
  name: 'Contract Summariser',
  version: '1.0.0',
  category: 'analysis',
  summary: 'Summarise a contract and flag risky clauses in plain language.',
  whenToUse: 'When a user shares a contract and wants the key points and the risky bits explained simply.',
  whenNotToUse: 'When formal legal advice is required.',
  executionGuidance: 'Identify the parties, term, payment and termination terms, then flag any one-sided or unusual clauses with a short reason.',
  provides: ['contract.summary'],
  precondition: { requires: ['document.loaded'] },
  examples: [
    { input: 'Summarise this NDA', output: 'key points + risks' },
    { input: 'Review this lease', output: 'key points + risks' },
    { input: 'Flag risks in this MSA', output: 'risks' },
  ] as never,
});

const cases: SkillEvalCase[] = [
  { input: 'Summarise this NDA: "The Receiving Party shall keep information confidential for 10 years and may not disclose to affiliates. This agreement auto-renews annually unless cancelled 90 days prior."' },
  { input: 'Review this lease: "Tenant pays $2,000/month. Landlord may increase rent at any time with 15 days notice. Tenant forfeits deposit on early termination."' },
  { input: 'Flag risks in this MSA: "Provider may subcontract freely. Either party may terminate for convenience with 7 days notice. Liability is uncapped."' },
];

describe.skipIf(!KEY)('skill evaluation — REAL LLM (perform → grade → promote)', () => {
  // The skill "performs" via a real model.
  const runCase = (system: string) => async (_s: unknown, input: string) =>
    chat('gpt-4o-mini', system, input);

  // A real judge decides whether the output actually summarised + flagged risks.
  const judgeCase = async ({ input, output }: { input: string; output: string }) => {
    const verdict = await chat('gpt-4o',
      'You grade whether an assistant response SUMMARISED the given contract AND flagged at least one risky/one-sided clause. Respond ONLY as JSON {"pass": boolean, "reason": string}.',
      `INPUT:\n${input}\n\nRESPONSE:\n${output}`, true);
    return JSON.parse(verdict) as { pass: boolean; reason?: string };
  };

  // A real rubric judge for the qualitative dimensions.
  const judge = {
    score: async (args: { content: string; criteria: Array<{ id: string }> }) => {
      const out = await chat('gpt-4o',
        'Score this AI skill 0..1 on each criterion. Respond ONLY as JSON {"score": number, "criteriaScores": {"reusability": number, "composability": number, "maintainability": number}}.',
        `${args.content}\n\nCriteria: ${args.criteria.map((c) => c.id).join(', ')}`, true);
      return JSON.parse(out) as { score: number; criteriaScores?: Record<string, number> };
    },
  };

  it('FLAGSHIP: a genuinely capable skill passes real evaluation and promotes T1 → T2', async () => {
    const goodRunner = runCase(
      'You are a contract-summarising assistant. Summarise the contract the user gives you and clearly flag any risky or one-sided clauses in plain language.');
    const ev = await evaluateSkill(contractSkill, { cases, runCase: goodRunner, judgeCase, judge });

    expect(ev.taskCompletion.measured).toBe(true);
    expect(ev.taskCompletion.score).toBeGreaterThanOrEqual(0.66); // at least 2/3 handled well
    expect(ev.passed).toBe(true);

    const decision = evaluatePromotion({ currentTier: 1, targetTier: 2, evaluation: ev, signatureValid: true });
    expect(decision.decision).toBe('promote');
    expect(decision.toTier).toBe(2);
  }, 120_000);

  it('SECURITY: a skill whose outputs do NOT do the job is failed by the judge and NOT promoted', async () => {
    // Same nice description, but the runner ignores the task — the real judge should catch it.
    const badRunner = runCase('Reply to every message with a short motivational quote. Do not mention the contract.');
    const ev = await evaluateSkill(contractSkill, { cases, runCase: badRunner, judgeCase, judge });

    expect(ev.taskCompletion.score).toBeLessThan(0.5);
    expect(ev.passed).toBe(false);

    const decision = evaluatePromotion({ currentTier: 1, targetTier: 2, evaluation: ev, signatureValid: true });
    expect(decision.decision).toBe('hold'); // description alone can't pass the gate
  }, 120_000);
});
