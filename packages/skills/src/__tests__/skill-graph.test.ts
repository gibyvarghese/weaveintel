// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { defineSkill } from '../types.js';
import { resolveSkillGraph, detectRequiresCycle, isSkillTerminated } from '../skill-graph.js';

// A realistic multi-step analytics pipeline: load → analyze → report, with a chart add-on and
// two mutually-exclusive report styles.
const load = defineSkill({ id: 'load', name: 'Dataset Loader', summary: 'Load a dataset into the workspace.', provides: ['dataset.loaded'] });
const analyze = defineSkill({ id: 'analyze', name: 'Dataset Analyst', summary: 'Compute stats over a dataset.', requires: ['load'], precondition: { requires: ['dataset.loaded'] }, provides: ['analysis.done'] });
const report = defineSkill({ id: 'report', name: 'Report Writer', summary: 'Write a report from an analysis.', requires: ['analyze'], precondition: { requires: ['analysis.done'] }, provides: ['report.done'] });
const chart = defineSkill({ id: 'chart', name: 'Chart Maker', summary: 'Draw charts from an analysis.', composesWith: ['analyze'], precondition: { requires: ['analysis.done'] }, provides: ['chart.done'] });
const reportFormal = defineSkill({ id: 'report-formal', name: 'Formal Report', summary: 'Formal style.', conflictsWith: ['report-casual'], priority: 10, requires: ['analyze'], precondition: { requires: ['analysis.done'] } });
const reportCasual = defineSkill({ id: 'report-casual', name: 'Casual Report', summary: 'Casual style.', conflictsWith: ['report-formal'], priority: 3, requires: ['analyze'], precondition: { requires: ['analysis.done'] } });
const catalog = [load, analyze, report, chart, reportFormal, reportCasual];

describe('skill graph — POSITIVE', () => {
  it('A requires B → B is pulled in and ordered BEFORE A', () => {
    const r = resolveSkillGraph([report], catalog); // only 'report' selected
    const ids = r.ordered.map((s) => s.id);
    expect(ids).toEqual(['load', 'analyze', 'report']);          // full chain, correct order
    expect([...r.added].sort()).toEqual(['analyze', 'load']);     // deps auto-pulled in
  });

  it('orders by typed inputs/outputs (provides → precondition), not just requires', () => {
    // chart only *composesWith* analyze (soft) but its precondition needs 'analysis.done'.
    const r = resolveSkillGraph([analyze, chart], catalog, { availableCapabilities: ['dataset.loaded'] });
    const ids = r.ordered.map((s) => s.id);
    expect(ids.indexOf('analyze')).toBeLessThan(ids.indexOf('chart')); // chart waits for analysis
  });

  it('a skill whose inputs are already in context runs immediately (no dependency pulled)', () => {
    const r = resolveSkillGraph([analyze], catalog, { availableCapabilities: ['dataset.loaded'] });
    // 'load' is still required by 'analyze' (hard requires), so it is pulled — but the precondition
    // is already met. Order still load→analyze because requires is a hard edge.
    expect(r.ordered.map((s) => s.id)).toEqual(['load', 'analyze']);
  });

  it('composesWith is pulled in only when asked (soft, not required)', () => {
    const withOut = resolveSkillGraph([analyze], catalog, { availableCapabilities: ['dataset.loaded'] });
    expect(withOut.ordered.find((s) => s.id === 'chart')).toBeUndefined();
    const withIn = resolveSkillGraph([analyze], catalog, { availableCapabilities: ['dataset.loaded'], includeComposesWith: true });
    // analyze composesWith? no; chart composesWith analyze — pulling composesWith follows the
    // selected skill's OWN composesWith, so analyze alone doesn't pull chart. This asserts the
    // soft edge is directional and safe (no surprise expansion).
    expect(withIn.ordered.map((s) => s.id)).toEqual(['load', 'analyze']);
  });

  it('termination: satisfiedWhen + maxIterations', () => {
    const s = defineSkill({ id: 't', name: 'T', summary: 's', termination: { satisfiedWhen: ['done'], maxIterations: 3 } });
    expect(isSkillTerminated(s, [])).toBe(false);
    expect(isSkillTerminated(s, ['done'])).toBe(true);
    expect(isSkillTerminated(s, [], 3)).toBe(true);
    expect(isSkillTerminated(defineSkill({ id: 'x', name: 'X', summary: 's' }), ['done'])).toBe(false); // no contract → never auto-terminates
  });
});

describe('skill graph — NEGATIVE', () => {
  it('detects a requires CYCLE (A→B→A) and reports the path instead of looping forever', () => {
    const a = defineSkill({ id: 'a', name: 'A', summary: 'a', requires: ['b'] });
    const b = defineSkill({ id: 'b', name: 'B', summary: 'b', requires: ['a'] });
    const cyc = detectRequiresCycle([a, b]);
    expect(cyc).not.toBeNull();
    expect(cyc![0]).toBe(cyc![cyc!.length - 1]);        // path closes on itself
    const r = resolveSkillGraph([a], [a, b]);
    expect(r.cycle).toBeDefined();                       // surfaced, not thrown
    expect(r.ordered.length).toBe(0);                    // nothing can be ordered (both stuck)
    expect(r.deferred.map((d) => d.id).sort()).toEqual(['a', 'b']);
  });

  it('requires a missing/disabled skill → dropped with a clear reason (no crash)', () => {
    const a = defineSkill({ id: 'a', name: 'A', summary: 'a', requires: ['ghost'] });
    const r = resolveSkillGraph([a], [a]);
    expect(r.dropped.some((d) => d.reason.includes('ghost'))).toBe(true);
    expect(r.ordered.map((s) => s.id)).toEqual(['a']);   // a still runs (its dep was optional-by-absence)
  });

  it('a precondition that can never be satisfied → the skill is DEFERRED with the missing token', () => {
    const needs = defineSkill({ id: 'needs', name: 'Needs X', summary: 's', precondition: { requires: ['never.produced'] } });
    const r = resolveSkillGraph([needs], [needs]);
    expect(r.ordered.length).toBe(0);
    expect(r.deferred[0]!.missing).toContain('never.produced');
  });
});

describe('skill graph — SECURITY', () => {
  const lowTrust = defineSkill({ id: 'low', name: 'Low', summary: 's', trust: 1, requires: ['high'] });
  const highTrust = defineSkill({ id: 'high', name: 'High', summary: 's', trust: 5, provides: ['privileged.capability'] });

  it('a low-trust skill CANNOT pull in a higher-trust dependency (no privilege escalation)', () => {
    const r = resolveSkillGraph([lowTrust], [lowTrust, highTrust]);
    expect(r.ordered.find((s) => s.id === 'high')).toBeUndefined();      // high-trust NOT pulled in
    expect(r.added).not.toContain('high');
    expect(r.dropped.some((d) => d.id === 'high' && /escalation/i.test(d.reason))).toBe(true);
  });

  it('a high-trust skill CAN require a lower-trust one (safe direction)', () => {
    const hi = defineSkill({ id: 'hi', name: 'Hi', summary: 's', trust: 5, requires: ['lo'] });
    const lo = defineSkill({ id: 'lo', name: 'Lo', summary: 's', trust: 1 });
    const r = resolveSkillGraph([hi], [hi, lo]);
    expect(r.ordered.map((s) => s.id)).toEqual(['lo', 'hi']);
  });

  it('conflicting skills cannot both be active — higher priority/trust wins deterministically', () => {
    const r = resolveSkillGraph([reportFormal, reportCasual], catalog, { availableCapabilities: ['analysis.done'] });
    const ids = r.ordered.map((s) => s.id);
    expect(ids).toContain('report-formal');       // priority 10 wins
    expect(ids).not.toContain('report-casual');   // priority 3 dropped
    expect(r.dropped.some((d) => d.id === 'report-casual' && /conflict/i.test(d.reason))).toBe(true);
  });

  it('runaway dependency fan-out is capped by maxSkills (no unbounded expansion)', () => {
    const many = defineSkill({ id: 'root', name: 'Root', summary: 's', requires: Array.from({ length: 500 }, (_, i) => `d${i}`) });
    const deps = Array.from({ length: 500 }, (_, i) => defineSkill({ id: `d${i}`, name: `D${i}`, summary: 's' }));
    const r = resolveSkillGraph([many], [many, ...deps], { maxSkills: 20 });
    expect(r.ordered.length + r.deferred.length).toBeLessThanOrEqual(20);
    expect(r.dropped.some((d) => /size limit/.test(d.reason))).toBe(true);
  });

  it('a deep requires chain is bounded by maxDepth', () => {
    // 0 requires 1 requires 2 ... requires 40
    const chain = Array.from({ length: 41 }, (_, i) =>
      defineSkill({ id: `c${i}`, name: `C${i}`, summary: 's', requires: i < 40 ? [`c${i + 1}`] : [] }));
    const r = resolveSkillGraph([chain[0]!], chain, { maxDepth: 8, maxSkills: 100 });
    // only ~8 levels deep get pulled in — the rest are not expanded.
    expect(r.ordered.length + r.deferred.length).toBeLessThanOrEqual(10);
  });
});

describe('skill graph — STRESS', () => {
  it('a 200-node linear dependency chain resolves in order in < 20ms', () => {
    const n = 200;
    const chain = Array.from({ length: n }, (_, i) =>
      defineSkill({ id: `s${i}`, name: `S${i}`, summary: 's', requires: i > 0 ? [`s${i - 1}`] : [], provides: [`p${i}`] }));
    const t0 = performance.now();
    const r = resolveSkillGraph([chain[n - 1]!], chain, { maxSkills: n + 10, maxDepth: n + 10 });
    const ms = performance.now() - t0;
    expect(r.ordered.map((s) => s.id)).toEqual(chain.map((s) => s.id)); // s0 → s199 in order
    expect(ms).toBeLessThan(20);
  });

  it('a wide 1,000-node graph with cross dependencies resolves fast and stays bounded', () => {
    const n = 1000;
    const skills = Array.from({ length: n }, (_, i) =>
      defineSkill({ id: `g${i}`, name: `G${i}`, summary: 's', requires: i > 2 ? [`g${i - 1}`, `g${i - 2}`] : [], provides: [`c${i}`] }));
    const t0 = performance.now();
    const r = resolveSkillGraph([skills[n - 1]!], skills, { maxSkills: n + 10, maxDepth: n + 10 });
    const ms = performance.now() - t0;
    expect(r.ordered.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(100);
  });

  it('cycle detection on a 1,000-node graph with one back-edge is fast', () => {
    const n = 1000;
    const skills = Array.from({ length: n }, (_, i) =>
      defineSkill({ id: `n${i}`, name: `N${i}`, summary: 's', requires: i > 0 ? [`n${i - 1}`] : [] }));
    // inject a back-edge: n0 requires n999 → one big cycle
    skills[0] = defineSkill({ ...skills[0]!, requires: ['n999'] });
    const t0 = performance.now();
    const cyc = detectRequiresCycle(skills);
    expect(cyc).not.toBeNull();
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
