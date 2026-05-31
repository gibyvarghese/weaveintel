/**
 * @weaveintel/compliance — durable variants of the six in-memory managers.
 *
 * Each factory takes `{ runtime?, namespace? }` and returns an async-flavored
 * manager backed by `runtime.persistence.kv` (Phase 4). When no runtime or
 * persistence slot is supplied, falls back to `weaveInMemoryPersistence()`
 * so the zero-config DX still works.
 *
 * Six in-memory stores in this package cannot be the production posture for
 * any regulated deployment — these are the durable forms.
 */
import {
  weaveInMemoryPersistence,
  type RuntimeKvStore,
  type WeaveRuntime,
} from '@weaveintel/core';
import type { LegalHold, LegalHoldStatus } from './legal-hold.js';
import type { ConsentFlag, ConsentPurpose } from './consent.js';
import type { ResidencyConstraint } from './residency.js';
import type { RetentionRule, RetentionAction } from './retention.js';
import type { AuditExport, ExportFormat } from './audit-export.js';
import type { DeletionRequest } from './deletion.js';

/* ------------------------------------------------------------------ */
/*  Internal: namespaced KV helper                                     */
/* ------------------------------------------------------------------ */

interface DurableOpts {
  runtime?: WeaveRuntime;
  namespace?: string;
}

function resolveKv(runtime: WeaveRuntime | undefined): RuntimeKvStore {
  return runtime?.persistence?.kv ?? weaveInMemoryPersistence().kv;
}

async function loadAll<T>(kv: RuntimeKvStore, ns: string): Promise<T[]> {
  const entries = await kv.list(`${ns}:`);
  const out: T[] = [];
  for (const e of entries) {
    try { out.push(JSON.parse(e.value) as T); } catch { /* skip malformed */ }
  }
  return out;
}

async function loadOne<T>(kv: RuntimeKvStore, ns: string, id: string): Promise<T | undefined> {
  const v = await kv.get(`${ns}:${id}`);
  if (!v) return undefined;
  try { return JSON.parse(v) as T; } catch { return undefined; }
}

async function saveOne<T>(kv: RuntimeKvStore, ns: string, id: string, value: T): Promise<void> {
  await kv.set(`${ns}:${id}`, JSON.stringify(value));
}

/* ------------------------------------------------------------------ */
/*  Legal Hold                                                         */
/* ------------------------------------------------------------------ */

export interface DurableLegalHoldManager {
  create(hold: Omit<LegalHold, 'issuedAt' | 'releasedAt' | 'status'>): Promise<LegalHold>;
  get(id: string): Promise<LegalHold | undefined>;
  list(): Promise<readonly LegalHold[]>;
  release(id: string): Promise<LegalHold | undefined>;
  isHeld(subjectId: string, dataCategory: string): Promise<boolean>;
}

export function createDurableLegalHoldManager(opts: DurableOpts = {}): DurableLegalHoldManager {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'legal-hold';

  return {
    async create(hold) {
      const h: LegalHold = { ...hold, status: 'active', issuedAt: Date.now(), releasedAt: null };
      await saveOne(kv, ns, h.id, h);
      return h;
    },
    async get(id) { return loadOne<LegalHold>(kv, ns, id); },
    async list() { return loadAll<LegalHold>(kv, ns); },
    async release(id) {
      const existing = await loadOne<LegalHold>(kv, ns, id);
      if (!existing) return undefined;
      const updated: LegalHold = { ...existing, status: 'released' as LegalHoldStatus, releasedAt: Date.now() };
      await saveOne(kv, ns, id, updated);
      return updated;
    },
    async isHeld(subjectId, dataCategory) {
      const all = await loadAll<LegalHold>(kv, ns);
      const now = Date.now();
      for (const hold of all) {
        if (hold.status !== 'active') continue;
        if (hold.expiresAt && now > hold.expiresAt) continue;
        const subjectMatch = hold.subjectIds.includes(subjectId) || hold.subjectIds.includes('*');
        const categoryMatch = hold.dataCategories.includes(dataCategory) || hold.dataCategories.includes('*');
        if (subjectMatch && categoryMatch) return true;
      }
      return false;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Consent                                                            */
/* ------------------------------------------------------------------ */

export interface DurableConsentManager {
  grant(subjectId: string, purpose: ConsentPurpose, source: string, expiresAt?: number): Promise<ConsentFlag>;
  revoke(subjectId: string, purpose: ConsentPurpose): Promise<boolean>;
  isGranted(subjectId: string, purpose: ConsentPurpose): Promise<boolean>;
  listBySubject(subjectId: string): Promise<readonly ConsentFlag[]>;
  listByPurpose(purpose: ConsentPurpose): Promise<readonly ConsentFlag[]>;
}

export function createDurableConsentManager(opts: DurableOpts = {}): DurableConsentManager {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'consent';
  const key = (s: string, p: ConsentPurpose) => `${s}::${p}`;

  return {
    async grant(subjectId, purpose, source, expiresAt) {
      const flag: ConsentFlag = { subjectId, purpose, granted: true, grantedAt: Date.now(), expiresAt: expiresAt ?? null, source };
      await saveOne(kv, ns, key(subjectId, purpose), flag);
      return flag;
    },
    async revoke(subjectId, purpose) {
      return kv.delete(`${ns}:${key(subjectId, purpose)}`);
    },
    async isGranted(subjectId, purpose) {
      const flag = await loadOne<ConsentFlag>(kv, ns, key(subjectId, purpose));
      if (!flag || !flag.granted) return false;
      if (flag.expiresAt && Date.now() > flag.expiresAt) return false;
      return true;
    },
    async listBySubject(subjectId) {
      const all = await loadAll<ConsentFlag>(kv, ns);
      return all.filter((f) => f.subjectId === subjectId);
    },
    async listByPurpose(purpose) {
      const all = await loadAll<ConsentFlag>(kv, ns);
      return all.filter((f) => f.purpose === purpose);
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Residency                                                          */
/* ------------------------------------------------------------------ */

export interface DurableResidencyEngine {
  addConstraint(c: ResidencyConstraint): Promise<void>;
  getConstraint(id: string): Promise<ResidencyConstraint | undefined>;
  listConstraints(): Promise<readonly ResidencyConstraint[]>;
  removeConstraint(id: string): Promise<boolean>;
  isAllowed(dataCategory: string, targetRegion: string): Promise<boolean>;
  getAllowedRegions(dataCategory: string): Promise<readonly string[]>;
}

export function createDurableResidencyEngine(opts: DurableOpts = {}): DurableResidencyEngine {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'residency';

  return {
    async addConstraint(c) { await saveOne(kv, ns, c.id, c); },
    async getConstraint(id) { return loadOne<ResidencyConstraint>(kv, ns, id); },
    async listConstraints() { return loadAll<ResidencyConstraint>(kv, ns); },
    async removeConstraint(id) { return kv.delete(`${ns}:${id}`); },
    async isAllowed(dataCategory, targetRegion) {
      const all = await loadAll<ResidencyConstraint>(kv, ns);
      for (const c of all) {
        if (!c.enabled) continue;
        if (!c.dataCategories.includes(dataCategory) && !c.dataCategories.includes('*')) continue;
        if (c.deniedRegions.includes(targetRegion)) return false;
        if (c.allowedRegions.length > 0 && !c.allowedRegions.includes(targetRegion)) return false;
      }
      return true;
    },
    async getAllowedRegions(dataCategory) {
      const all = await loadAll<ResidencyConstraint>(kv, ns);
      const allowed = new Set<string>();
      for (const c of all) {
        if (!c.enabled) continue;
        if (!c.dataCategories.includes(dataCategory) && !c.dataCategories.includes('*')) continue;
        for (const r of c.allowedRegions) allowed.add(r);
      }
      return Array.from(allowed);
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Retention                                                          */
/* ------------------------------------------------------------------ */

export interface DurableRetentionEngine {
  addRule(rule: Omit<RetentionRule, 'createdAt'>): Promise<RetentionRule>;
  getRule(id: string): Promise<RetentionRule | undefined>;
  listRules(): Promise<readonly RetentionRule[]>;
  removeRule(id: string): Promise<boolean>;
  evaluate(dataCategory: string, createdAt: number): Promise<RetentionAction | null>;
}

export function createDurableRetentionEngine(opts: DurableOpts = {}): DurableRetentionEngine {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'retention';

  return {
    async addRule(rule) {
      const r: RetentionRule = { ...rule, createdAt: Date.now() };
      await saveOne(kv, ns, r.id, r);
      return r;
    },
    async getRule(id) { return loadOne<RetentionRule>(kv, ns, id); },
    async listRules() { return loadAll<RetentionRule>(kv, ns); },
    async removeRule(id) { return kv.delete(`${ns}:${id}`); },
    async evaluate(dataCategory, createdAt) {
      const all = await loadAll<RetentionRule>(kv, ns);
      const now = Date.now();
      for (const rule of all) {
        if (!rule.enabled) continue;
        if (rule.dataCategory !== dataCategory && rule.dataCategory !== '*') continue;
        const ageMs = now - createdAt;
        if (ageMs > rule.retentionDays * 86_400_000) return rule.action;
      }
      return null;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Audit Export                                                       */
/* ------------------------------------------------------------------ */

export interface DurableAuditExportManager {
  create(tenantId: string, requestedBy: string, format: ExportFormat, categories: string[], fromDate: number, toDate: number): Promise<AuditExport>;
  get(id: string): Promise<AuditExport | undefined>;
  list(tenantId: string): Promise<readonly AuditExport[]>;
  markReady(id: string, recordCount: number, sizeBytes: number): Promise<AuditExport | undefined>;
  markFailed(id: string): Promise<AuditExport | undefined>;
}

export function createDurableAuditExportManager(opts: DurableOpts = {}): DurableAuditExportManager {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'audit-export';

  function nextId(): string {
    return `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  return {
    async create(tenantId, requestedBy, format, categories, fromDate, toDate) {
      const exp: AuditExport = {
        id: nextId(), tenantId, requestedBy, format, status: 'pending',
        dataCategories: categories, fromDate, toDate,
        createdAt: Date.now(), completedAt: null, recordCount: 0, sizeBytes: 0,
      };
      await saveOne(kv, ns, exp.id, exp);
      return exp;
    },
    async get(id) { return loadOne<AuditExport>(kv, ns, id); },
    async list(tenantId) {
      const all = await loadAll<AuditExport>(kv, ns);
      return all.filter((e) => e.tenantId === tenantId);
    },
    async markReady(id, recordCount, sizeBytes) {
      const existing = await loadOne<AuditExport>(kv, ns, id);
      if (!existing) return undefined;
      const updated: AuditExport = { ...existing, status: 'ready', recordCount, sizeBytes, completedAt: Date.now() };
      await saveOne(kv, ns, id, updated);
      return updated;
    },
    async markFailed(id) {
      const existing = await loadOne<AuditExport>(kv, ns, id);
      if (!existing) return undefined;
      const updated: AuditExport = { ...existing, status: 'failed', completedAt: Date.now() };
      await saveOne(kv, ns, id, updated);
      return updated;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Deletion                                                           */
/* ------------------------------------------------------------------ */

export interface DurableDeletionManager {
  create(subjectId: string, requestedBy: string, reason: string, dataCategories: string[]): Promise<DeletionRequest>;
  get(id: string): Promise<DeletionRequest | undefined>;
  list(): Promise<readonly DeletionRequest[]>;
  process(id: string): Promise<DeletionRequest | undefined>;
  complete(id: string): Promise<DeletionRequest | undefined>;
  fail(id: string, reason: string): Promise<DeletionRequest | undefined>;
  block(id: string, reason: string): Promise<DeletionRequest | undefined>;
}

export function createDurableDeletionManager(opts: DurableOpts = {}): DurableDeletionManager {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'deletion';

  function nextId(): string {
    return `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function patch(id: string, p: Partial<DeletionRequest>): Promise<DeletionRequest | undefined> {
    const existing = await loadOne<DeletionRequest>(kv, ns, id);
    if (!existing) return undefined;
    const updated = { ...existing, ...p } as DeletionRequest;
    await saveOne(kv, ns, id, updated);
    return updated;
  }

  return {
    async create(subjectId, requestedBy, reason, dataCategories) {
      const req: DeletionRequest = {
        id: nextId(), subjectId, requestedBy, reason, status: 'pending',
        dataCategories, createdAt: Date.now(), completedAt: null, blockedReason: null,
      };
      await saveOne(kv, ns, req.id, req);
      return req;
    },
    async get(id) { return loadOne<DeletionRequest>(kv, ns, id); },
    async list() { return loadAll<DeletionRequest>(kv, ns); },
    async process(id) { return patch(id, { status: 'in-progress' }); },
    async complete(id) { return patch(id, { status: 'completed', completedAt: Date.now() }); },
    async fail(id, reason) { return patch(id, { status: 'failed', blockedReason: reason }); },
    async block(id, reason) { return patch(id, { status: 'blocked', blockedReason: reason }); },
  };
}
