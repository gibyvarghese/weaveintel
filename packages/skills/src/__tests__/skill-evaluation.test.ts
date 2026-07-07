// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { defineSkill } from '../types.js';
import {
  evaluateSkill,
  evaluatePromotion,
  deprecateSkill,
  retireSkill,
  isSkillUsable,
  lifecycleForEvaluation,
  type SkillEvaluation,
  type SkillEvalCase,
} from '../skill-evaluation.js';

// A high-quality, well-described skill: general, composable, maintainable.
const goodSkill = defineSkill({
  id: 'summarise-contract',
  name: 'Contract Summariser',
  version: '1.3.0',
  category: 'analysis',
  summary: 'Summarise a contract and flag risky clauses.',
  whenToUse: 'When a user shares a contract or agreement and wants the key points and risks in plain language.',
  whenNotToUse: 'When the user needs formal legal advice.',
  executionGuidance: 'Read the document, extract obligations and dates, and flag unusual or one-sided clauses with a short explanation.',
  provides: ['contract.summary'],
  precondition: { requires: ['document.loaded'] },
  toolNames: ['read_document'],
  triggerPatterns: ['summarise contract', 'review agreement'],
  completionContract: { requiredOutputs: ['summary', 'risks'] } as never,
  examples: [
    { input: 'Summarise this NDA', output: 'Key points + risks' },
    { input: 'Review this lease', output: 'Key points + risks' },
    { input: 'Flag risky clauses in this MSA', output: 'Risks' },
  ] as never,
});

// A thin, brittle one-off: no examples, no typing, terse.
const poorSkill = defineSkill({ id: 'do-thing', name: 'Do Thing', summary: 'Does the thing.', whenToUse: 'always' });

// Example cases for measuring task completion.
const cases: SkillEvalCase[] = [
  { input: 'Summarise this NDA between Acme and Globex', expectation: 'risk' },
  { input: 'Review this 12-month lease agreement', expectation: 'risk' },
  { input: 'Flag risky clauses in this master services agreement', expectation: 'risk' },
];

describe('skill evaluation — POSITIVE', () => {
  it('a well-built skill scores well across the qualitative dimensions', async () => {
    const ev = await evaluateSkill(goodSkill);
    expect(ev.composability.score).toBeGreaterThan(0.6);   // typed provides/precondition
    expect(ev.maintainability.score).toBeGreaterThan(0.6); // versioned, examples, contract
    expect(ev.reusability.score).toBeGreaterThan(0.6);     // several examples, general when-to-use
    expect(ev.taskCompletion.measured).toBe(false);        // no cases run here
    expect(ev.findings.some((f) => /not measured/.test(f))).toBe(true);
  });

  it('measures task completion by RUNNING the skill on example cases', async () => {
    // A fake "agent" that behaves well — always produces a summary that mentions risks.
    const runCase = async () => 'Summary: parties, term, payment. Risks: auto-renewal clause, unilateral termination.';
    const ev = await evaluateSkill(goodSkill, { cases, runCase });
    expect(ev.taskCompletion.measured).toBe(true);
    expect(ev.taskCompletion.score).toBe(1);   // 3/3 outputs mention "risk"
    expect(ev.passed).toBe(true);
  });

  it('a poor, brittle skill scores low and does not pass', async () => {
    const ev = await evaluateSkill(poorSkill);
    expect(ev.overall).toBeLessThan(0.7);
    expect(ev.passed).toBe(false);
  });

  it('an injected judge refines the qualitative scores', async () => {
    const judge = { score: async () => ({ score: 0.9, criteriaScores: { reusability: 1, composability: 1, maintainability: 1 } }) };
    const base = await evaluateSkill(poorSkill);
    const judged = await evaluateSkill(poorSkill, { judge });
    expect(judged.reusability.score).toBeGreaterThan(base.reusability.score); // pulled up by the judge
    expect(judged.reusability.reasons).toContain('refined by judge');
  });
});

describe('skill evaluation — NEGATIVE', () => {
  it('a skill that fails its example cases does not pass', async () => {
    const runCase = async () => 'Here is a nice poem about spring.'; // never addresses the task
    const ev = await evaluateSkill(goodSkill, { cases, runCase });
    expect(ev.taskCompletion.score).toBe(0);
    expect(ev.passed).toBe(false);
    expect(ev.taskCompletion.reasons.some((r) => /0\/3|failed/.test(r))).toBe(true);
  });

  it('a case runner that throws is counted as a failure, not a crash', async () => {
    const runCase = async () => { throw new Error('tool timeout'); };
    const ev = await evaluateSkill(goodSkill, { cases, runCase });
    expect(ev.taskCompletion.score).toBe(0);
    expect(ev.taskCompletion.reasons.some((r) => /errored|timeout/.test(r))).toBe(true);
  });

  it('a broken judge falls back to heuristics instead of failing the evaluation', async () => {
    const judge = { score: async () => { throw new Error('judge offline'); } };
    const ev = await evaluateSkill(goodSkill, { judge });
    expect(ev.findings.some((f) => /judge errored/.test(f))).toBe(true);
    expect(ev.composability.score).toBeGreaterThan(0); // heuristics still produced scores
  });
});

describe('skill evaluation — promotion gating (SECURITY: anti-gaming)', () => {
  const passingEval: SkillEvaluation = {
    skillId: 'x', overall: 0.9, passed: true,
    reusability: { score: 0.9, measured: true, reasons: [] },
    composability: { score: 0.9, measured: true, reasons: [] },
    maintainability: { score: 0.9, measured: true, reasons: [] },
    taskCompletion: { score: 0.95, measured: true, reasons: [] },
    findings: [],
  };

  it('a clean, signed, passing skill promotes T1 → T2', () => {
    const d = evaluatePromotion({ currentTier: 1, targetTier: 2, evaluation: passingEval, signatureValid: true });
    expect(d.decision).toBe('promote');
    expect(d.toTier).toBe(2);
  });

  it('a passing skill is NOT promoted to T2 without a signature', () => {
    const d = evaluatePromotion({ currentTier: 1, targetTier: 2, evaluation: passingEval, signatureValid: false });
    expect(d.decision).toBe('hold');
    expect(d.toTier).toBe(1);
  });

  it('a GAMED eval cannot reach the human-gated tier T3 on its own', () => {
    // Even a perfect (possibly poisoned) eval + valid signature cannot self-promote to T3.
    const d = evaluatePromotion({ currentTier: 2, targetTier: 3, evaluation: passingEval, signatureValid: true, humanApproved: false });
    expect(d.toTier).toBeLessThan(3);
    expect(d.reasons.some((r) => /human approval/.test(r))).toBe(true);
  });

  it('with human approval, the same skill DOES reach T3', () => {
    const d = evaluatePromotion({ currentTier: 2, targetTier: 3, evaluation: passingEval, signatureValid: true, humanApproved: true });
    expect(d.decision).toBe('promote');
    expect(d.toTier).toBe(3);
  });

  it('a failing evaluation holds the tier', () => {
    const failing = { ...passingEval, passed: false, overall: 0.4 };
    const d = evaluatePromotion({ currentTier: 1, targetTier: 2, evaluation: failing, signatureValid: true });
    expect(d.decision).toBe('hold');
  });

  it('a regression against a baseline auto-DEMOTES a tier', () => {
    const regressed = { ...passingEval, overall: 0.6, taskCompletion: { score: 0.5, measured: true, reasons: [] } };
    const d = evaluatePromotion({ currentTier: 3, targetTier: 3, evaluation: regressed, baseline: passingEval, signatureValid: true });
    expect(d.decision).toBe('demote');
    expect(d.toTier).toBe(2);
  });
});

describe('skill evaluation — lifecycle', () => {
  it('deprecate keeps a skill usable but points to a replacement', () => {
    const d = deprecateSkill(goodSkill, { reason: 'superseded', replacedBy: 'summarise-contract-v2' });
    expect(d.lifecycle).toBe('deprecated');
    expect(d.deprecation?.replacedBy).toBe('summarise-contract-v2');
    expect(isSkillUsable(d)).toBe(true); // still works, just warns
  });

  it('retire disables a skill entirely', () => {
    const r = retireSkill(goodSkill, 'no longer maintained');
    expect(r.lifecycle).toBe('retired');
    expect(r.enabled).toBe(false);
    expect(isSkillUsable(r)).toBe(false);
  });

  it('a regressed skill is auto-moved to deprecated (demote-after-repair)', () => {
    const baseline = { overall: 0.9 } as SkillEvaluation;
    const now = { overall: 0.5 } as SkillEvaluation;
    const l = lifecycleForEvaluation('active', now, { baseline });
    expect(l.next).toBe('deprecated');
    expect(l.changed).toBe(true);
  });

  it('a draft that passes becomes active', () => {
    const l = lifecycleForEvaluation('draft', { overall: 0.85, passed: true } as SkillEvaluation, {});
    expect(l.next).toBe('active');
  });
});

describe('skill evaluation — STRESS', () => {
  it('evaluates 1,000 skills (heuristics only) well within a nightly budget', async () => {
    const skills = Array.from({ length: 1000 }, (_, i) => defineSkill({
      id: `s${i}`, name: `Skill ${i}`, version: '1.0.0', summary: `Does job ${i}.`,
      whenToUse: `When the user needs job ${i} done with some detail here.`,
      provides: [`out${i}`], precondition: { requires: ['in'] },
      examples: [{ input: 'a', output: 'b' }, { input: 'c', output: 'd' }] as never,
    }));
    const t0 = performance.now();
    let passed = 0;
    for (const s of skills) if ((await evaluateSkill(s)).overall > 0.5) passed++;
    const ms = performance.now() - t0;
    expect(passed).toBe(1000);
    expect(ms).toBeLessThan(2_000);
  }, 30_000);

  it('1,000 skills WITH 3 example cases each and a fast runner stays within budget', async () => {
    const skills = Array.from({ length: 1000 }, (_, i) => defineSkill({ id: `t${i}`, name: `T${i}`, version: '1.0.0', summary: 's', whenToUse: 'when a detailed situation arises here', examples: [{ input: 'a', output: 'b' }] as never }));
    const runCase = async () => 'result contains the answer';
    const localCases: SkillEvalCase[] = [{ input: 'q1', expectation: 'answer' }, { input: 'q2', expectation: 'answer' }, { input: 'q3', expectation: 'answer' }];
    const t0 = performance.now();
    for (const s of skills) await evaluateSkill(s, { cases: localCases, runCase });
    expect(performance.now() - t0).toBeLessThan(5_000);
  }, 30_000);
});
