// SPDX-License-Identifier: MIT
/**
 * @weaveintel/skills — Tenant- and team-scoped skill overlays, and the skill store port.
 *
 * A vendor skill is shared by every organisation that runs the product. An organisation (tenant) and a
 * team inside it may each lay an overlay on it: text that APPENDS to the skill's guidance and a policy
 * that only TIGHTENS (fewer tools, no side effects, approval required, a shorter budget). Resolution is
 * vendor → tenant → team, one team per call; an overlay for another tenant or another team never applies.
 *
 * Unlike `withSkillOverlay`, the tightening here is strict: an overlay's `allowedTools` is INTERSECTED
 * with the base's, so an overlay can never grant a tool the vendor skill did not allow.
 */

import { isSkillUsable } from './skill-evaluation.js';
import type { SkillDefinition, SkillExtensionOverlay, SkillPolicyControls } from './types.js';
import { withSkillOverlay } from './types.js';

/** An overlay bound to a tenant (org layer) and optionally a team inside it (team layer). */
export interface ScopedSkillOverlay extends SkillExtensionOverlay {
  /** The tenant whose layer this is. Absent = a vendor overlay (applies everywhere). */
  readonly tenantId?: string;
  /** The team inside the tenant. Requires `tenantId`. */
  readonly teamId?: string;
}

/** Whose call it is. */
export interface SkillScope {
  readonly tenantId?: string;
  readonly teamId?: string;
}

/** The layer an overlay sits at. */
export function overlayLayer(o: Pick<ScopedSkillOverlay, 'tenantId' | 'teamId'>): 'vendor' | 'org' | 'team' {
  if (o.teamId !== undefined && o.teamId !== '') return 'team';
  if (o.tenantId !== undefined && o.tenantId !== '') return 'org';
  return 'vendor';
}

/**
 * Tighten a policy: tools only narrow (intersection), disallowed tools add up, side effects can only be
 * switched off, approval can only be switched on, the budget only shortens.
 */
export function tightenSkillPolicy(base: SkillPolicyControls | undefined, overlay: SkillPolicyControls | undefined): SkillPolicyControls | undefined {
  if (overlay === undefined) return base;
  if (base === undefined) return overlay;
  const allowedTools = base.allowedTools === undefined
    ? overlay.allowedTools
    : overlay.allowedTools === undefined
      ? base.allowedTools
      : base.allowedTools.filter((t) => overlay.allowedTools!.includes(t));
  const disallowed = [...new Set([...(base.disallowedTools ?? []), ...(overlay.disallowedTools ?? [])])];
  const budget = Math.min(base.runtimeBudgetMs ?? Number.POSITIVE_INFINITY, overlay.runtimeBudgetMs ?? Number.POSITIVE_INFINITY);
  return {
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(disallowed.length > 0 ? { disallowedTools: disallowed } : {}),
    ...(base.sideEffectsAllowed === false || overlay.sideEffectsAllowed === false ? { sideEffectsAllowed: false } : base.sideEffectsAllowed === undefined && overlay.sideEffectsAllowed === undefined ? {} : { sideEffectsAllowed: base.sideEffectsAllowed ?? true }),
    ...(base.requiresApproval === true || overlay.requiresApproval === true ? { requiresApproval: true } : {}),
    ...((overlay.sensitivityHandling ?? base.sensitivityHandling) === undefined ? {} : { sensitivityHandling: overlay.sensitivityHandling ?? base.sensitivityHandling }),
    ...(Number.isFinite(budget) ? { runtimeBudgetMs: budget } : {}),
    ...((base.tenantBoundary ?? overlay.tenantBoundary) === undefined ? {} : { tenantBoundary: base.tenantBoundary ?? overlay.tenantBoundary }),
  } as SkillPolicyControls;
}

/** Apply one overlay with strict tightening (text appends; policy tightens; an org/team may only disable). */
export function withScopedOverlay(base: SkillDefinition, overlay: ScopedSkillOverlay): SkillDefinition {
  if (base.id !== overlay.skillId) return base;
  const layer = overlayLayer(overlay);
  const merged = withSkillOverlay(base, { ...overlay, stricterPolicy: undefined, enabled: undefined });
  // An org or team may switch a skill OFF for itself, never back on past a vendor "off".
  const enabled = layer === 'vendor' ? (overlay.enabled ?? base.enabled) : base.enabled === false ? false : overlay.enabled === false ? false : base.enabled;
  const policy = tightenSkillPolicy(base.policy, overlay.stricterPolicy);
  return { ...merged, ...(enabled === undefined ? {} : { enabled }), ...(policy === undefined ? {} : { policy }) };
}

/**
 * Resolve a skill for one call: vendor overlays, then the tenant's, then the team's. Overlays for another
 * tenant, or a team overlay when the call names a different team (or none), are ignored.
 */
export function resolveScopedSkill(base: SkillDefinition, overlays: readonly ScopedSkillOverlay[], scope: SkillScope = {}): SkillDefinition {
  const mine = overlays.filter((o) => o.skillId === base.id);
  const vendor = mine.filter((o) => overlayLayer(o) === 'vendor');
  const org = scope.tenantId === undefined ? [] : mine.filter((o) => overlayLayer(o) === 'org' && o.tenantId === scope.tenantId);
  const team = scope.tenantId === undefined || scope.teamId === undefined ? [] : mine.filter((o) => overlayLayer(o) === 'team' && o.tenantId === scope.tenantId && o.teamId === scope.teamId);
  return [...vendor, ...org, ...team].reduce((acc, o) => withScopedOverlay(acc, o), base);
}

/** The result of evaluating a skill (or one of its prompt versions) against its eval cases. */
export interface SkillEvalRecord {
  readonly skillId: string;
  readonly scope: SkillScope;
  readonly passed: boolean;
  readonly summary: string;
  readonly score?: number;
  readonly at: string;
  /** What was evaluated, e.g. a prompt version id. */
  readonly subjectRef?: string;
}

/** Storage-neutral skill store: vendor definitions plus scoped overlays and eval results. */
export interface SkillStore {
  get(skillId: string): Promise<SkillDefinition | undefined>;
  list(): Promise<SkillDefinition[]>;
  putOverlay(overlay: ScopedSkillOverlay): Promise<void>;
  overlays(skillId: string): Promise<ScopedSkillOverlay[]>;
  /** The skill as one call sees it. Undefined when unknown. */
  resolve(skillId: string, scope: SkillScope): Promise<SkillDefinition | undefined>;
  recordEval(record: SkillEvalRecord): Promise<void>;
  /** The most recent eval for a skill at a scope (team, else tenant, else vendor). */
  latestEval(skillId: string, scope: SkillScope): Promise<SkillEvalRecord | undefined>;
}

/** Why a skill store refused. */
export class SkillStoreError extends Error {
  readonly code: 'UNKNOWN_SKILL' | 'TEAM_WITHOUT_TENANT';
  constructor(code: SkillStoreError['code'], message: string) {
    super(message);
    this.name = 'SkillStoreError';
    this.code = code;
  }
}

/** Reference implementation. */
export class InMemorySkillStore implements SkillStore {
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly layered: ScopedSkillOverlay[] = [];
  private readonly evals: SkillEvalRecord[] = [];

  constructor(skills: readonly SkillDefinition[] = []) {
    for (const s of skills) this.skills.set(s.id, s);
  }

  async get(skillId: string): Promise<SkillDefinition | undefined> {
    return this.skills.get(skillId);
  }

  async list(): Promise<SkillDefinition[]> {
    return [...this.skills.values()];
  }

  async putOverlay(overlay: ScopedSkillOverlay): Promise<void> {
    if (!this.skills.has(overlay.skillId)) throw new SkillStoreError('UNKNOWN_SKILL', `There is no skill "${overlay.skillId}".`);
    if ((overlay.teamId ?? '') !== '' && (overlay.tenantId ?? '') === '') throw new SkillStoreError('TEAM_WITHOUT_TENANT', 'A team overlay has to name its tenant.');
    this.layered.push(overlay);
  }

  async overlays(skillId: string): Promise<ScopedSkillOverlay[]> {
    return this.layered.filter((o) => o.skillId === skillId);
  }

  async resolve(skillId: string, scope: SkillScope): Promise<SkillDefinition | undefined> {
    const base = this.skills.get(skillId);
    return base === undefined ? undefined : resolveScopedSkill(base, this.layered, scope);
  }

  async recordEval(record: SkillEvalRecord): Promise<void> {
    this.evals.push(record);
  }

  async latestEval(skillId: string, scope: SkillScope): Promise<SkillEvalRecord | undefined> {
    const of = (s: SkillScope) => this.evals.filter((e) => e.skillId === skillId && (e.scope.tenantId ?? '') === (s.tenantId ?? '') && (e.scope.teamId ?? '') === (s.teamId ?? '')).at(-1);
    return (scope.teamId === undefined ? undefined : of(scope)) ?? (scope.tenantId === undefined ? undefined : of({ tenantId: scope.tenantId })) ?? of({});
  }
}

/**
 * Whether a skill may be offered to a call: usable by its lifecycle (not draft, not retired, enabled) and,
 * when an eval result is supplied, one that passed. A skill with no eval result is judged by lifecycle alone.
 */
export function isSkillActivatable(skill: SkillDefinition, latestEval?: Pick<SkillEvalRecord, 'passed'>): boolean {
  if ((skill.lifecycle ?? 'active') === 'draft') return false;
  if (!isSkillUsable(skill)) return false;
  if (latestEval !== undefined && !latestEval.passed) return false;
  return true;
}
