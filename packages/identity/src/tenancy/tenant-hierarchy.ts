// SPDX-License-Identifier: MIT
/**
 * Tenant hierarchy — turn "tenant" from a free-text label into a real entity with a parent/child tree.
 *
 * A **tenant** is any isolated customer/org/workspace. Most apps start with exactly one (a single
 * company using the product); larger ones grow a tree — a holding company with regional
 * subsidiaries, an MSP reselling to its customers, an enterprise with departments. This module gives
 * you that tree as a small, storage-backed primitive:
 *
 *   const org = createInMemoryTenantHierarchy();           // or the SQL-backed store (SQLite/Postgres)
 *   const acme = await org.create({ name: 'Acme Corp' });  // a root
 *   const emea = await org.create({ name: 'EMEA', parentTenantId: acme.id });
 *   const uk   = await org.create({ name: 'Acme UK', parentTenantId: emea.id });
 *   await org.ancestors(uk.id);    // [Acme Corp, EMEA]  — e.g. for rolling billing up to the parent
 *   await org.descendants(acme.id) // [EMEA, Acme UK]     — e.g. everything under a customer
 *   await org.reparent(uk.id, acme.id); // Acme UK now reports straight to Acme Corp
 *
 * It stays tiny and portable on purpose (materialized paths, no recursive SQL — see `hierarchy-path`),
 * so the same behaviour runs identically on an embedded SQLite file and a clustered Postgres.
 */
import { newUUIDv7 } from '@weaveintel/core';
import {
  assertUsableTenantId,
  ancestorPaths,
  buildPath,
  depthOf,
  isStrictAncestor,
  rebasePath,
  wouldCreateCycle,
} from './hierarchy-path.js';

/** Lifecycle state of a tenant. Not an enum in the DB — apps may add their own values. */
export type TenantStatus = 'active' | 'suspended' | 'archived' | (string & {});

/** A tenant node in the tree. */
export interface Tenant {
  /** Stable unique id. Also the segment used in `path`, so it must not contain "/". */
  readonly id: string;
  /** Human-friendly name (not unique). */
  readonly name: string;
  /** The parent tenant's id, or `null` for a root/top-level tenant. */
  readonly parentTenantId: string | null;
  /** Materialized lineage path, e.g. `/acme/emea/uk/`. Unique across the tree. */
  readonly path: string;
  /** Distance from a root: roots are 0, their children 1, and so on. */
  readonly depth: number;
  /** Lifecycle state. */
  readonly status: TenantStatus;
  /** Free-form app data (billing plan, external ids, region, …). */
  readonly metadata: Record<string, unknown>;
  /** ISO-8601 creation time. */
  readonly createdAt: string;
  /** ISO-8601 last-update time. */
  readonly updatedAt: string;
}

/** Input to `create`. Only `name` is required. */
export interface CreateTenantInput {
  /** Provide your own id, or let the store mint a UUIDv7. Must not contain "/". */
  readonly id?: string;
  readonly name: string;
  /** Parent id, or omit/`null` for a root tenant. */
  readonly parentTenantId?: string | null;
  readonly status?: TenantStatus;
  readonly metadata?: Record<string, unknown>;
}

/** Options for `descendants` / `subtree`. */
export interface SubtreeOptions {
  /** Only include nodes at most this many levels below the starting node (1 = immediate children). */
  readonly maxDepth?: number;
  /** Include archived/suspended tenants too (default: include everything). */
  readonly statuses?: readonly TenantStatus[];
}

/**
 * Storage-agnostic contract for a tenant tree. Implemented in-memory (this file) and over SQL
 * (`tenant-hierarchy-sql`), both proven against the same conformance suite.
 */
export interface TenantHierarchyStore {
  /** Create a tenant. Throws if the parent doesn't exist or the id is already taken. */
  create(input: CreateTenantInput): Promise<Tenant>;
  /** Fetch one tenant by id, or `null`. */
  get(id: string): Promise<Tenant | null>;
  /** Fetch one tenant by its exact path, or `null`. */
  getByPath(path: string): Promise<Tenant | null>;
  /** All top-level (parent-less) tenants. */
  roots(): Promise<Tenant[]>;
  /** Immediate children of a tenant. */
  children(id: string): Promise<Tenant[]>;
  /** Ancestors from root down to the immediate parent (excludes the node itself). */
  ancestors(id: string): Promise<Tenant[]>;
  /** Everything strictly below a tenant (excludes the node itself), depth-then-path ordered. */
  descendants(id: string, opts?: SubtreeOptions): Promise<Tenant[]>;
  /** The tenant plus everything below it. */
  subtree(id: string, opts?: SubtreeOptions): Promise<Tenant[]>;
  /** Move a tenant (and its whole subtree) under a new parent, or to a root (`null`). Cycle-safe. */
  reparent(id: string, newParentTenantId: string | null): Promise<Tenant>;
  /** Rename a tenant. */
  rename(id: string, name: string): Promise<Tenant>;
  /** Change lifecycle status. */
  setStatus(id: string, status: TenantStatus): Promise<Tenant>;
  /** Merge metadata (shallow) onto a tenant. */
  setMetadata(id: string, metadata: Record<string, unknown>): Promise<Tenant>;
  /** Delete a tenant. Fails if it has children unless `cascade` is set. */
  delete(id: string, opts?: { cascade?: boolean }): Promise<void>;
  /** Total tenant count. */
  count(): Promise<number>;
  /**
   * Idempotently ensure a single default root tenant exists — the "one company using the product"
   * starting point. Returns the existing one if already present. Handy for the single-org case where
   * the tree collapses to one node.
   */
  ensureDefault(input?: { id?: string; name?: string }): Promise<Tenant>;
}

/** Raised when a tenant id is not found. */
export class TenantNotFoundError extends Error {
  constructor(id: string) {
    super(`Tenant ${JSON.stringify(id)} not found.`);
    this.name = 'TenantNotFoundError';
  }
}
/** Raised when creating a tenant whose id already exists. */
export class DuplicateTenantError extends Error {
  constructor(id: string) {
    super(`Tenant ${JSON.stringify(id)} already exists.`);
    this.name = 'DuplicateTenantError';
  }
}
/** Raised when a move would make a tenant its own ancestor. */
export class TenantCycleError extends Error {
  constructor(id: string, newParentId: string) {
    super(`Cannot move tenant ${JSON.stringify(id)} under ${JSON.stringify(newParentId)}: that node is inside its own subtree (a cycle).`);
    this.name = 'TenantCycleError';
  }
}
/** Raised when deleting a tenant that still has children without `cascade`. */
export class TenantHasChildrenError extends Error {
  constructor(id: string) {
    super(`Tenant ${JSON.stringify(id)} still has children — delete them first or pass { cascade: true }.`);
    this.name = 'TenantHasChildrenError';
  }
}

export const DEFAULT_TENANT_ID = 'default';

/** Monotonic ISO clock so createdAt/updatedAt never tie within a process (stable ordering). */
function monotonicClock(): () => string {
  let last = 0;
  return () => {
    const t = Math.max(Date.now(), last + 1);
    last = t;
    return new Date(t).toISOString();
  };
}

/**
 * In-memory reference implementation — the behavioural source of truth. Fast, dependency-free, ideal
 * for tests and single-process apps; the SQL store must match it exactly (proven by the contract).
 */
export function createInMemoryTenantHierarchy(): TenantHierarchyStore {
  const byId = new Map<string, Tenant>();
  const now = monotonicClock();

  const requireTenant = (id: string): Tenant => {
    const t = byId.get(id);
    if (!t) throw new TenantNotFoundError(id);
    return t;
  };
  const sortByDepthThenPath = (a: Tenant, b: Tenant): number =>
    a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const matchesStatuses = (t: Tenant, statuses?: readonly TenantStatus[]): boolean =>
    !statuses || statuses.includes(t.status);

  return {
    async create(input) {
      const id = input.id ?? newUUIDv7();
      assertUsableTenantId(id);
      if (byId.has(id)) throw new DuplicateTenantError(id);
      const parentTenantId = input.parentTenantId ?? null;
      const parent = parentTenantId == null ? null : requireTenant(parentTenantId);
      const path = buildPath(parent?.path ?? null, id);
      const ts = now();
      const tenant: Tenant = {
        id,
        name: input.name,
        parentTenantId,
        path,
        depth: depthOf(path),
        status: input.status ?? 'active',
        metadata: input.metadata ?? {},
        createdAt: ts,
        updatedAt: ts,
      };
      byId.set(id, tenant);
      return tenant;
    },
    async get(id) {
      return byId.get(id) ?? null;
    },
    async getByPath(path) {
      for (const t of byId.values()) if (t.path === path) return t;
      return null;
    },
    async roots() {
      return [...byId.values()].filter((t) => t.parentTenantId == null).sort(sortByDepthThenPath);
    },
    async children(id) {
      requireTenant(id);
      return [...byId.values()].filter((t) => t.parentTenantId === id).sort(sortByDepthThenPath);
    },
    async ancestors(id) {
      const t = requireTenant(id);
      const paths = new Set(ancestorPaths(t.path));
      return [...byId.values()].filter((x) => paths.has(x.path)).sort(sortByDepthThenPath);
    },
    async descendants(id, opts) {
      const t = requireTenant(id);
      return [...byId.values()]
        .filter(
          (x) =>
            isStrictAncestor(t.path, x.path) &&
            (opts?.maxDepth == null || x.depth - t.depth <= opts.maxDepth) &&
            matchesStatuses(x, opts?.statuses),
        )
        .sort(sortByDepthThenPath);
    },
    async subtree(id, opts) {
      const t = requireTenant(id);
      return [...byId.values()]
        .filter(
          (x) =>
            (x.path === t.path || isStrictAncestor(t.path, x.path)) &&
            (opts?.maxDepth == null || x.depth - t.depth <= opts.maxDepth) &&
            matchesStatuses(x, opts?.statuses),
        )
        .sort(sortByDepthThenPath);
    },
    async reparent(id, newParentTenantId) {
      const t = requireTenant(id);
      if (wouldCreateCycle(t.path, newParentTenantId == null ? null : requireTenant(newParentTenantId).path)) {
        throw new TenantCycleError(id, newParentTenantId!);
      }
      const newParent = newParentTenantId == null ? null : requireTenant(newParentTenantId);
      const oldRoot = t.path;
      const newRoot = buildPath(newParent?.path ?? null, id);
      const ts = now();
      for (const node of [...byId.values()]) {
        if (node.path === oldRoot || isStrictAncestor(oldRoot, node.path)) {
          const path = rebasePath(oldRoot, newRoot, node.path);
          byId.set(node.id, {
            ...node,
            path,
            depth: depthOf(path),
            parentTenantId: node.id === id ? (newParentTenantId ?? null) : node.parentTenantId,
            updatedAt: ts,
          });
        }
      }
      return requireTenant(id);
    },
    async rename(id, name) {
      const t = requireTenant(id);
      const updated = { ...t, name, updatedAt: now() };
      byId.set(id, updated);
      return updated;
    },
    async setStatus(id, status) {
      const t = requireTenant(id);
      const updated = { ...t, status, updatedAt: now() };
      byId.set(id, updated);
      return updated;
    },
    async setMetadata(id, metadata) {
      const t = requireTenant(id);
      const updated = { ...t, metadata: { ...t.metadata, ...metadata }, updatedAt: now() };
      byId.set(id, updated);
      return updated;
    },
    async delete(id, opts) {
      const t = requireTenant(id);
      const kids = [...byId.values()].filter((x) => x.parentTenantId === id);
      if (kids.length > 0 && !opts?.cascade) throw new TenantHasChildrenError(id);
      for (const node of [...byId.values()]) {
        if (node.path === t.path || isStrictAncestor(t.path, node.path)) byId.delete(node.id);
      }
    },
    async count() {
      return byId.size;
    },
    async ensureDefault(input) {
      const id = input?.id ?? DEFAULT_TENANT_ID;
      const existing = byId.get(id);
      if (existing) return existing;
      return this.create({ id, name: input?.name ?? 'Default' });
    },
  };
}
