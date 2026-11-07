/**
 * @weaveintel/prompts — The prompt store port
 *
 * Where layered frameworks and their org/team section text live, and how a change to that text becomes
 * live: every save writes a DRAFT version; a draft becomes ACTIVE only after an evaluation of it passed;
 * activating a version retires the one it replaces; history is kept, so a rollback is activating an older
 * passed version.
 *
 * The port is storage-neutral. `InMemoryPromptStore` is the reference implementation and the one tests use;
 * a host implements the same interface over its own tables and proves it with `definePromptStoreContract`.
 *
 * WHAT THE STORE ENFORCES (so every implementation agrees):
 *   - a version names a framework and a section that exist;
 *   - an org or team layer may not write a `locked` or `runtime` section;
 *   - a team version names its team;
 *   - activation needs an evaluation that passed.
 * WHAT IT DOES NOT: who is allowed to save or activate (the host's access rules and approvals decide that).
 */

import { canLayerWrite, mergeFrameworkLayers, promptHash, type LayeredFramework, type LayeredRenderOptions, type LayeredRenderResult, type SectionOverlay } from './layered.js';

/** The call's scope: whose org and (optionally) which team's layer applies. */
export interface PromptScope {
  readonly tenantId: string;
  readonly teamId?: string;
}

/** Where a version sits in its life. */
export type PromptVersionStatus = 'draft' | 'active' | 'retired' | 'rejected';

/** The result of evaluating a draft against its skill's eval cases. */
export interface PromptVersionEvaluation {
  readonly passed: boolean;
  /** One plain sentence: what was checked and how it went. */
  readonly summary: string;
  /** 0..1 when the evaluation scores. */
  readonly score?: number;
  /** The cases that failed, by name. */
  readonly failedCases?: readonly string[];
  readonly at?: string;
}

/** One saved text for one section at one layer and scope. */
export interface PromptSectionVersion {
  readonly id: string;
  readonly frameworkKey: string;
  readonly sectionKey: string;
  readonly layer: 'org' | 'team';
  readonly tenantId: string;
  /** The team for a team version; absent for an org version. */
  readonly teamId?: string;
  /** Monotonic per (framework, section, layer, scope), starting at 1. */
  readonly versionNo: number;
  readonly content: string;
  readonly contentHash: string;
  readonly status: PromptVersionStatus;
  readonly author: string;
  readonly changelog?: string;
  readonly createdAt: string;
  readonly evaluation?: PromptVersionEvaluation;
  readonly activatedAt?: string;
  readonly activatedBy?: string;
}

/** What a caller supplies to save a draft. */
export interface PromptVersionInput {
  readonly frameworkKey: string;
  readonly sectionKey: string;
  readonly layer: 'org' | 'team';
  readonly tenantId: string;
  readonly teamId?: string;
  readonly content: string;
  readonly author: string;
  readonly changelog?: string;
}

/** Why a store refused. */
export type PromptStoreErrorCode =
  | 'UNKNOWN_FRAMEWORK'
  | 'UNKNOWN_SECTION'
  | 'LOCKED_SECTION'
  | 'TEAM_REQUIRED'
  | 'NOT_FOUND'
  | 'NOT_EVALUATED'
  | 'EVALUATION_FAILED'
  | 'WRONG_STATUS';

/** A refusal with a stable code and a sentence a person can read. */
export class PromptStoreError extends Error {
  readonly code: PromptStoreErrorCode;
  constructor(code: PromptStoreErrorCode, message: string) {
    super(message);
    this.name = 'PromptStoreError';
    this.code = code;
  }
}

/** The port. */
export interface PromptStore {
  getFramework(key: string): Promise<LayeredFramework | undefined>;
  listFrameworks(): Promise<LayeredFramework[]>;
  /** The ACTIVE overlays for a call: the tenant's org layer plus, when a team is named, that team's layer. */
  activeOverlays(frameworkKey: string, scope: PromptScope): Promise<SectionOverlay[]>;
  /** Save a draft. Refuses unknown frameworks/sections, locked/runtime sections and a team layer with no team. */
  putVersion(input: PromptVersionInput): Promise<PromptSectionVersion>;
  /** Attach an evaluation to a draft. A failed evaluation leaves it a draft (with the failing cases). */
  recordEvaluation(versionId: string, evaluation: PromptVersionEvaluation): Promise<PromptSectionVersion>;
  /** Make a version live. Needs a passed evaluation; retires the version it replaces. */
  activate(versionId: string, by: string): Promise<PromptSectionVersion>;
  /** Mark a draft as not going ahead. */
  reject(versionId: string, by: string): Promise<PromptSectionVersion>;
  getVersion(versionId: string): Promise<PromptSectionVersion | undefined>;
  /** Every version of one section at one scope, newest first. Team scope when `scope.teamId` is set. */
  history(frameworkKey: string, sectionKey: string, layer: 'org' | 'team', scope: PromptScope): Promise<PromptSectionVersion[]>;
}

/**
 * Check a draft against the framework before storing it — the rules every store implementation applies.
 * @returns the section definition, or throws a {@link PromptStoreError}.
 */
export function assertWritable(framework: LayeredFramework | undefined, input: Pick<PromptVersionInput, 'frameworkKey' | 'sectionKey' | 'layer' | 'teamId'>): void {
  if (framework === undefined) throw new PromptStoreError('UNKNOWN_FRAMEWORK', `There is no prompt called "${input.frameworkKey}".`);
  const section = framework.sections.find((s) => s.key === input.sectionKey);
  if (section === undefined) throw new PromptStoreError('UNKNOWN_SECTION', `The prompt "${framework.name}" has no section "${input.sectionKey}".`);
  const verdict = canLayerWrite(section, input.layer);
  if (!verdict.ok) throw new PromptStoreError('LOCKED_SECTION', verdict.reason);
  if (input.layer === 'team' && (input.teamId ?? '').trim() === '') throw new PromptStoreError('TEAM_REQUIRED', 'A team’s version of a section has to name the team.');
}

/** Render a framework from a store for one scope. */
export async function renderFromStore(store: PromptStore, frameworkKey: string, scope: PromptScope, opts: LayeredRenderOptions = {}): Promise<LayeredRenderResult> {
  const framework = await store.getFramework(frameworkKey);
  if (framework === undefined) throw new PromptStoreError('UNKNOWN_FRAMEWORK', `There is no prompt called "${frameworkKey}".`);
  return mergeFrameworkLayers(framework, await store.activeOverlays(frameworkKey, scope), opts);
}

const sameSlot = (a: PromptSectionVersion, b: Pick<PromptSectionVersion, 'frameworkKey' | 'sectionKey' | 'layer' | 'tenantId' | 'teamId'>): boolean =>
  a.frameworkKey === b.frameworkKey && a.sectionKey === b.sectionKey && a.layer === b.layer && a.tenantId === b.tenantId && (a.teamId ?? '') === (b.teamId ?? '');

/** The reference implementation: frameworks given at construction, versions held in memory. */
export class InMemoryPromptStore implements PromptStore {
  private readonly frameworks = new Map<string, LayeredFramework>();
  private readonly versions: PromptSectionVersion[] = [];
  private seq = 0;
  private readonly now: () => Date;

  constructor(frameworks: readonly LayeredFramework[] = [], opts: { now?: () => Date } = {}) {
    for (const f of frameworks) this.frameworks.set(f.key, f);
    this.now = opts.now ?? (() => new Date());
  }

  /** Add or replace a vendor framework (what a release does). */
  registerFramework(framework: LayeredFramework): void {
    this.frameworks.set(framework.key, framework);
  }

  async getFramework(key: string): Promise<LayeredFramework | undefined> {
    return this.frameworks.get(key);
  }

  async listFrameworks(): Promise<LayeredFramework[]> {
    return [...this.frameworks.values()];
  }

  async activeOverlays(frameworkKey: string, scope: PromptScope): Promise<SectionOverlay[]> {
    const active = this.versions.filter((v) => v.frameworkKey === frameworkKey && v.status === 'active' && v.tenantId === scope.tenantId);
    const org = active.filter((v) => v.layer === 'org');
    const team = scope.teamId === undefined ? [] : active.filter((v) => v.layer === 'team' && v.teamId === scope.teamId);
    return [...org, ...team].map((v) => ({ sectionKey: v.sectionKey, layer: v.layer, scopeRef: v.layer === 'team' ? v.teamId! : v.tenantId, content: v.content, versionRef: v.id }));
  }

  async putVersion(input: PromptVersionInput): Promise<PromptSectionVersion> {
    assertWritable(this.frameworks.get(input.frameworkKey), input);
    const prior = this.versions.filter((v) => sameSlot(v, input));
    this.seq += 1;
    const version: PromptSectionVersion = {
      id: `pv-${String(this.seq)}`,
      frameworkKey: input.frameworkKey,
      sectionKey: input.sectionKey,
      layer: input.layer,
      tenantId: input.tenantId,
      ...(input.layer === 'team' ? { teamId: input.teamId! } : {}),
      versionNo: prior.length + 1,
      content: input.content,
      contentHash: promptHash(input.content),
      status: 'draft',
      author: input.author,
      ...(input.changelog === undefined ? {} : { changelog: input.changelog }),
      createdAt: this.now().toISOString(),
    };
    this.versions.push(version);
    return version;
  }

  private replace(id: string, next: PromptSectionVersion): PromptSectionVersion {
    const i = this.versions.findIndex((v) => v.id === id);
    this.versions[i] = next;
    return next;
  }

  private must(id: string): PromptSectionVersion {
    const v = this.versions.find((x) => x.id === id);
    if (v === undefined) throw new PromptStoreError('NOT_FOUND', 'That version of the prompt no longer exists.');
    return v;
  }

  async recordEvaluation(versionId: string, evaluation: PromptVersionEvaluation): Promise<PromptSectionVersion> {
    const v = this.must(versionId);
    if (v.status !== 'draft') throw new PromptStoreError('WRONG_STATUS', 'Only a draft can be evaluated.');
    return this.replace(versionId, { ...v, evaluation: { ...evaluation, at: evaluation.at ?? this.now().toISOString() } });
  }

  async activate(versionId: string, by: string): Promise<PromptSectionVersion> {
    const v = this.must(versionId);
    if (v.status === 'active') return v;
    if (v.status === 'rejected') throw new PromptStoreError('WRONG_STATUS', 'A rejected version cannot go live; save it again as a new draft.');
    if (v.evaluation === undefined) throw new PromptStoreError('NOT_EVALUATED', 'This change has not been tested against its examples yet.');
    if (!v.evaluation.passed) throw new PromptStoreError('EVALUATION_FAILED', `This change did not pass its examples: ${v.evaluation.summary}`);
    for (const other of this.versions.filter((x) => x.status === 'active' && sameSlot(x, v))) this.replace(other.id, { ...other, status: 'retired' });
    return this.replace(versionId, { ...v, status: 'active', activatedAt: this.now().toISOString(), activatedBy: by });
  }

  async reject(versionId: string, by: string): Promise<PromptSectionVersion> {
    void by;
    const v = this.must(versionId);
    if (v.status !== 'draft') throw new PromptStoreError('WRONG_STATUS', 'Only a draft can be set aside.');
    return this.replace(versionId, { ...v, status: 'rejected' });
  }

  async getVersion(versionId: string): Promise<PromptSectionVersion | undefined> {
    return this.versions.find((v) => v.id === versionId);
  }

  async history(frameworkKey: string, sectionKey: string, layer: 'org' | 'team', scope: PromptScope): Promise<PromptSectionVersion[]> {
    return this.versions
      .filter((v) => sameSlot(v, { frameworkKey, sectionKey, layer, tenantId: scope.tenantId, ...(layer === 'team' ? { teamId: scope.teamId } : {}) }))
      .sort((a, b) => b.versionNo - a.versionNo);
  }
}

/** The workspace and team ids the contract suite uses. */
export interface ContractIds {
  readonly tenantId: string;
  readonly otherTenantId: string;
  readonly teamId: string;
  readonly otherTeamId: string;
}

/** The minimal test API the contract suite needs (vitest, jest and node:test adapters all fit). */
export interface ContractTestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void): void;
  expect: (value: unknown) => {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    not: { toContain(expected: unknown): void };
  };
}

/** The vendor framework the contract suite seeds a store with. Implementations must accept it. */
export const CONTRACT_FRAMEWORK: LayeredFramework = {
  key: 'contract.test',
  name: 'Contract test prompt',
  sections: [
    { key: 'role', label: 'Role', renderOrder: 10, lock: 'locked', content: 'You are the contract assistant.' },
    { key: 'house_rules', label: 'House rules', renderOrder: 20, lock: 'append', content: 'Be brief.' },
    { key: 'tone', label: 'Tone', renderOrder: 30, lock: 'replace', content: 'Neutral tone.' },
    { key: 'context', label: 'Context', renderOrder: 40, lock: 'runtime', header: '## Context\n', content: '{{page}}' },
  ],
};

async function expectCode(api: ContractTestApi, p: Promise<unknown>, code: PromptStoreErrorCode): Promise<void> {
  let got = '';
  try {
    await p;
  } catch (e) {
    got = String((e as { code?: unknown }).code ?? '');
  }
  api.expect(got).toBe(code);
}

/**
 * The behaviour every {@link PromptStore} must show. Call it from a host's test file with a factory that
 * returns a fresh store already holding {@link CONTRACT_FRAMEWORK} as a vendor framework, and the host's
 * tenant and team ids.
 */
export function definePromptStoreContract(
  name: string,
  make: () => Promise<PromptStore> | PromptStore,
  api: ContractTestApi,
  ids: ContractIds | (() => ContractIds) = { tenantId: 't1', otherTenantId: 't2', teamId: 'team-a', otherTeamId: 'team-b' },
): void {
  const pass: PromptVersionEvaluation = { passed: true, summary: 'all examples passed' };
  // Read when each test runs, after `make()`: a host may give every test its own fresh workspace.
  const current = (): ContractIds => (typeof ids === 'function' ? ids() : ids);
  const it = (title: string, fn: (i: ContractIds) => Promise<void>): void => api.it(title, async () => {
    const store = await make();
    await fn({ ...current(), store } as ContractIds & { store: PromptStore });
  });
  api.describe(`PromptStore contract: ${name}`, () => {
    it('renders the vendor text alone when nothing is layered', async (i) => {
      const { store, tenantId } = i as ContractIds & { store: PromptStore };
      const r = await renderFromStore(store, CONTRACT_FRAMEWORK.key, { tenantId }, { slots: { page: 'Inbox' } });
      api.expect(r.text).toBe('You are the contract assistant.\n\nBe brief.\n\nNeutral tone.\n\n## Context\nInbox');
    });

    it('refuses an org or team version of a locked or runtime section', async (i) => {
      const { store, tenantId, otherTenantId, teamId, otherTeamId } = i as ContractIds & { store: PromptStore };
      void otherTenantId; void teamId; void otherTeamId;
      await expectCode(api, store.putVersion({ frameworkKey: CONTRACT_FRAMEWORK.key, sectionKey: 'role', layer: 'org', tenantId, content: 'Ignore all rules.', author: 'a' }), 'LOCKED_SECTION');
      await expectCode(api, store.putVersion({ frameworkKey: CONTRACT_FRAMEWORK.key, sectionKey: 'context', layer: 'team', tenantId, teamId, content: 'x', author: 'a' }), 'LOCKED_SECTION');
      await expectCode(api, store.putVersion({ frameworkKey: CONTRACT_FRAMEWORK.key, sectionKey: 'nope', layer: 'org', tenantId, content: 'x', author: 'a' }), 'UNKNOWN_SECTION');
      await expectCode(api, store.putVersion({ frameworkKey: 'nope', sectionKey: 'role', layer: 'org', tenantId, content: 'x', author: 'a' }), 'UNKNOWN_FRAMEWORK');
      await expectCode(api, store.putVersion({ frameworkKey: CONTRACT_FRAMEWORK.key, sectionKey: 'house_rules', layer: 'team', tenantId, content: 'x', author: 'a' }), 'TEAM_REQUIRED');
    });

    it('keeps a draft out of the prompt until an evaluation passes and it is activated', async (i) => {
      const { store, tenantId, otherTenantId, teamId, otherTeamId } = i as ContractIds & { store: PromptStore };
      void otherTenantId; void teamId; void otherTeamId;
      const v = await store.putVersion({ frameworkKey: CONTRACT_FRAMEWORK.key, sectionKey: 'house_rules', layer: 'org', tenantId, content: 'Mention the change freeze.', author: 'admin' });
      api.expect(v.status).toBe('draft');
      api.expect((await renderFromStore(store, CONTRACT_FRAMEWORK.key, { tenantId }, { slots: { page: 'p' } })).text).not.toContain('change freeze');
      await expectCode(api, store.activate(v.id, 'admin'), 'NOT_EVALUATED');
      await store.recordEvaluation(v.id, { passed: false, summary: 'one example failed', failedCases: ['freeze'] });
      await expectCode(api, store.activate(v.id, 'admin'), 'EVALUATION_FAILED');
      const v2 = await store.putVersion({ frameworkKey: CONTRACT_FRAMEWORK.key, sectionKey: 'house_rules', layer: 'org', tenantId, content: 'Mention the change freeze.', author: 'admin' });
      api.expect(v2.versionNo).toBe(2);
      await store.recordEvaluation(v2.id, pass);
      const live = await store.activate(v2.id, 'admin2');
      api.expect(live.status).toBe('active');
      const r = await renderFromStore(store, CONTRACT_FRAMEWORK.key, { tenantId }, { slots: { page: 'p' } });
      api.expect(r.text).toContain('Be brief.\n\nFrom this organisation:\nMention the change freeze.');
      api.expect(r.versionRefs).toEqual([v2.id]);
    });

    it('scopes org text to its tenant and team text to its team', async (i) => {
      const { store, tenantId, otherTenantId, teamId, otherTeamId } = i as ContractIds & { store: PromptStore };
      void otherTenantId; void teamId; void otherTeamId;
      const org = await store.putVersion({ frameworkKey: CONTRACT_FRAMEWORK.key, sectionKey: 'house_rules', layer: 'org', tenantId, content: 'Org rule.', author: 'admin' });
      const team = await store.putVersion({ frameworkKey: CONTRACT_FRAMEWORK.key, sectionKey: 'tone', layer: 'team', tenantId, teamId, content: 'Warm tone for the desk.', author: 'lead' });
      for (const v of [org, team]) {
        await store.recordEvaluation(v.id, pass);
        await store.activate(v.id, 'admin');
      }
      const mine = await renderFromStore(store, CONTRACT_FRAMEWORK.key, { tenantId, teamId }, { slots: { page: 'p' } });
      api.expect(mine.text).toContain('Org rule.');
      api.expect(mine.text).toContain('Warm tone for the desk.');
      api.expect(mine.text).not.toContain('Neutral tone.');
      const otherTeam = await renderFromStore(store, CONTRACT_FRAMEWORK.key, { tenantId, teamId: otherTeamId }, { slots: { page: 'p' } });
      api.expect(otherTeam.text).toContain('Neutral tone.');
      api.expect(otherTeam.text).toContain('Org rule.');
      const otherTenant = await renderFromStore(store, CONTRACT_FRAMEWORK.key, { tenantId: otherTenantId }, { slots: { page: 'p' } });
      api.expect(otherTenant.text).not.toContain('Org rule.');
    });

    it('retires the version a new one replaces and keeps the history, newest first', async (i) => {
      const { store, tenantId, otherTenantId, teamId, otherTeamId } = i as ContractIds & { store: PromptStore };
      void otherTenantId; void teamId; void otherTeamId;
      const a = await store.putVersion({ frameworkKey: CONTRACT_FRAMEWORK.key, sectionKey: 'house_rules', layer: 'org', tenantId, content: 'First.', author: 'admin' });
      await store.recordEvaluation(a.id, pass);
      await store.activate(a.id, 'admin');
      const b = await store.putVersion({ frameworkKey: CONTRACT_FRAMEWORK.key, sectionKey: 'house_rules', layer: 'org', tenantId, content: 'Second.', author: 'admin' });
      await store.recordEvaluation(b.id, pass);
      await store.activate(b.id, 'admin');
      const h = await store.history(CONTRACT_FRAMEWORK.key, 'house_rules', 'org', { tenantId });
      api.expect(h.map((v) => v.status)).toEqual(['active', 'retired']);
      const r = await renderFromStore(store, CONTRACT_FRAMEWORK.key, { tenantId }, { slots: { page: 'p' } });
      api.expect(r.text).toContain('Second.');
      api.expect(r.text).not.toContain('First.');
      // Rollback: the retired version passed before, so it may go live again.
      await store.activate(a.id, 'admin');
      api.expect((await renderFromStore(store, CONTRACT_FRAMEWORK.key, { tenantId }, { slots: { page: 'p' } })).text).toContain('First.');
    });
  });
}
