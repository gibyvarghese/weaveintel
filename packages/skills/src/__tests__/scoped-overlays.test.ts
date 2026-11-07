import { describe, expect, it } from 'vitest';
import { activateSkills, defineSkill, InMemorySkillStore, resolveScopedSkill, tightenSkillPolicy, type ScopedSkillOverlay } from '../index.js';

const base = defineSkill({
  id: 'geni.dock.ask',
  name: 'Geni dock',
  summary: 'Answer questions about the page on show.',
  executionGuidance: 'Answer from the page and the person’s own data.',
  policy: { allowedTools: ['search', 'describe', 'assign'], requiresApproval: false, runtimeBudgetMs: 20_000 },
  modelTier: 'balanced',
  contextRecipeId: 'page.default',
});

const overlays: ScopedSkillOverlay[] = [
  { skillId: base.id, source: 'kauri admin', tenantId: 'kauri', executionGuidanceAppend: 'Always mention the change freeze.' },
  { skillId: base.id, source: 'desk lead', tenantId: 'kauri', teamId: 'desk', executionGuidanceAppend: 'Name the on-call.', stricterPolicy: { allowedTools: ['search', 'web_fetch'], runtimeBudgetMs: 10_000 } },
  { skillId: base.id, source: 'globex admin', tenantId: 'globex', executionGuidanceAppend: 'Globex only.' },
];

describe('resolveScopedSkill', () => {
  it('applies vendor → tenant → team, only for the call’s own tenant and team', () => {
    const desk = resolveScopedSkill(base, overlays, { tenantId: 'kauri', teamId: 'desk' });
    expect(desk.executionGuidance).toBe('Answer from the page and the person’s own data.\n\nAlways mention the change freeze.\n\nName the on-call.');
    const network = resolveScopedSkill(base, overlays, { tenantId: 'kauri', teamId: 'network' });
    expect(network.executionGuidance).not.toContain('on-call');
    expect(network.executionGuidance).toContain('change freeze');
    const globex = resolveScopedSkill(base, overlays, { tenantId: 'globex', teamId: 'desk' });
    expect(globex.executionGuidance).toContain('Globex only.');
    expect(globex.executionGuidance).not.toContain('change freeze');
    expect(globex.executionGuidance).not.toContain('on-call');
  });

  it('only tightens: an overlay cannot grant a tool the vendor skill did not allow, nor lengthen the budget', () => {
    const desk = resolveScopedSkill(base, overlays, { tenantId: 'kauri', teamId: 'desk' });
    expect(desk.policy?.allowedTools).toEqual(['search']);
    expect(desk.policy?.runtimeBudgetMs).toBe(10_000);
    const looser = tightenSkillPolicy({ requiresApproval: true, sideEffectsAllowed: false, runtimeBudgetMs: 5_000 }, { requiresApproval: false, sideEffectsAllowed: true, runtimeBudgetMs: 60_000 });
    expect(looser).toEqual({ requiresApproval: true, sideEffectsAllowed: false, runtimeBudgetMs: 5_000 });
  });

  it('lets an org switch a skill off for itself but never back on past a vendor “off”', () => {
    const off = resolveScopedSkill(base, [{ skillId: base.id, source: 'admin', tenantId: 'kauri', enabled: false }], { tenantId: 'kauri' })
    expect(off.enabled).toBe(false);
    const vendorOff = { ...base, enabled: false };
    expect(resolveScopedSkill(vendorOff, [{ skillId: base.id, source: 'admin', tenantId: 'kauri', enabled: true }], { tenantId: 'kauri' }).enabled).toBe(false);
  });
});

describe('InMemorySkillStore', () => {
  it('resolves per scope and keeps the latest eval at the most specific scope', async () => {
    const store = new InMemorySkillStore([base]);
    for (const o of overlays) await store.putOverlay(o);
    await expect(store.putOverlay({ skillId: 'nope', source: 'x' })).rejects.toMatchObject({ code: 'UNKNOWN_SKILL' });
    await expect(store.putOverlay({ skillId: base.id, source: 'x', teamId: 'desk' })).rejects.toMatchObject({ code: 'TEAM_WITHOUT_TENANT' });
    expect((await store.resolve(base.id, { tenantId: 'kauri', teamId: 'desk' }))?.policy?.allowedTools).toEqual(['search']);
    await store.recordEval({ skillId: base.id, scope: {}, passed: true, summary: 'vendor baseline', at: '1' });
    await store.recordEval({ skillId: base.id, scope: { tenantId: 'kauri' }, passed: false, summary: 'kauri draft failed', at: '2' });
    expect((await store.latestEval(base.id, { tenantId: 'kauri', teamId: 'desk' }))?.summary).toBe('kauri draft failed');
    expect((await store.latestEval(base.id, { tenantId: 'globex' }))?.summary).toBe('vendor baseline');
  });
});

describe('activateSkills honours lifecycle and evaluations', () => {
  const live = defineSkill({ id: 'a', name: 'Incident summary', summary: 'Summarise an incident from its notes', triggerPatterns: ['summarise incident'] });
  const draft = defineSkill({ id: 'b', name: 'Incident summary draft', summary: 'Summarise an incident from its notes', lifecycle: 'draft' });
  const failing = defineSkill({ id: 'c', name: 'Incident summary v2', summary: 'Summarise an incident from its notes' });
  it('never offers a draft, nor a skill whose latest eval failed', async () => {
    const r = await activateSkills('summarise this incident from its notes', [live, draft, failing], { evaluationOf: (id) => (id === 'c' ? { passed: false } : undefined), minScore: 0 });
    const ids = r.considered.map((m) => m.skill.id);
    expect(ids).toContain('a');
    expect(ids).not.toContain('b');
    expect(ids).not.toContain('c');
  });
  it('applies the call’s scoped overlays before matching', async () => {
    const r = await activateSkills('summarise this incident', [live], { scopedOverlays: [{ skillId: 'a', source: 'admin', tenantId: 'kauri', enabled: false }], scope: { tenantId: 'kauri' }, minScore: 0 });
    expect(r.considered).toEqual([]);
  });
});
