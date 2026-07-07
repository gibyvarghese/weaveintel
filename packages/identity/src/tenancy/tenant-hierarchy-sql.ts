// SPDX-License-Identifier: MIT
/**
 * SQL-backed tenant hierarchy — one implementation that runs identically on SQLite and Postgres.
 *
 * It talks to the database through a tiny `SqlClient` seam (`query(text, params) → { rows }`) — the
 * same shape `@weaveintel/persistence` uses. A `pg.Pool` satisfies it directly; for SQLite, wrap a
 * `better-sqlite3` database in ~5 lines (see the package README / tests). Because everything is a
 * materialized path (see `hierarchy-path`), the queries are plain `SELECT … LIKE`, `IN (…)` and one
 * string-rewrite `UPDATE` for moves — no `ltree`, no recursive CTEs, so both engines behave the same.
 */
import { newUUIDv7 } from '@weaveintel/core';
import {
  ancestorPaths,
  assertUsableTenantId,
  buildPath,
  depthDelta,
  depthOf,
  escapeLikePrefix,
  wouldCreateCycle,
} from './hierarchy-path.js';
import {
  DEFAULT_TENANT_ID,
  DuplicateTenantError,
  TenantCycleError,
  TenantHasChildrenError,
  TenantNotFoundError,
  type CreateTenantInput,
  type SubtreeOptions,
  type Tenant,
  type TenantHierarchyStore,
  type TenantStatus,
} from './tenant-hierarchy.js';

/** Minimal async SQL client — a `pg.Pool`/`pg.Client`, or a thin wrapper over `better-sqlite3`. */
export interface SqlClient {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export type SqlDialect = 'sqlite' | 'postgres';

export interface SqlTenantHierarchyOptions {
  /** The database client. Same shape as `@weaveintel/persistence`'s `SqlClient`. */
  readonly client: SqlClient;
  /** Which engine — controls placeholder style (`?` vs `$1`) and nothing else user-visible. */
  readonly dialect: SqlDialect;
  /** Table name (default `tenants`). Validated against `[A-Za-z_][A-Za-z0-9_]*`. */
  readonly table?: string;
  /** Skip `CREATE TABLE IF NOT EXISTS` on first use if you manage the schema yourself. */
  readonly ensureSchema?: boolean;
  /** Override id generation (tests / custom ids). */
  readonly idFactory?: () => string;
  /** Override the clock (tests). */
  readonly clock?: () => string;
}

/** DDL for the tenants table — identical shape on both engines (all portable types). */
export function tenantHierarchyDdl(table = 'tenants'): string[] {
  assertTable(table);
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
       id               TEXT PRIMARY KEY,
       name             TEXT NOT NULL,
       parent_tenant_id TEXT REFERENCES ${table}(id),
       path             TEXT NOT NULL,
       depth            INTEGER NOT NULL DEFAULT 0,
       status           TEXT NOT NULL DEFAULT 'active',
       metadata         TEXT NOT NULL DEFAULT '{}',
       created_at       TEXT NOT NULL,
       updated_at       TEXT NOT NULL
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_${table}_path ON ${table}(path)`,
    `CREATE INDEX IF NOT EXISTS ix_${table}_parent ON ${table}(parent_tenant_id)`,
  ];
}

function assertTable(table: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`Unsafe table name ${JSON.stringify(table)} — must match [A-Za-z_][A-Za-z0-9_]*.`);
  }
}

function monotonicClock(): () => string {
  let last = 0;
  return () => {
    const t = Math.max(Date.now(), last + 1);
    last = t;
    return new Date(t).toISOString();
  };
}

/** Marker for a pre-validated SQL fragment (identifiers, ORDER BY, ESCAPE clause) spliced verbatim. */
interface RawSql {
  readonly __raw: string;
}
function raw(s: string): RawSql {
  return { __raw: s };
}
function isRaw(v: unknown): v is RawSql {
  return typeof v === 'object' && v !== null && '__raw' in v;
}

/** Create a SQLite/Postgres-backed tenant hierarchy store. */
export function createSqlTenantHierarchy(opts: SqlTenantHierarchyOptions): TenantHierarchyStore {
  const { client, dialect } = opts;
  const table = opts.table ?? 'tenants';
  assertTable(table);
  const T = raw(table);
  const ORDER = raw('ORDER BY depth ASC, path ASC');
  const ESCAPE = raw("ESCAPE '\\'");
  const newId = opts.idFactory ?? newUUIDv7;
  const now = opts.clock ?? monotonicClock();

  let ready: Promise<void> | undefined;
  const ensure = (): Promise<void> => {
    if (opts.ensureSchema === false) return Promise.resolve();
    return (ready ??= (async () => {
      for (const stmt of tenantHierarchyDdl(table)) await client.query(stmt);
    })());
  };

  /** Tagged-template query runner: values become dialect-correct placeholders; `raw()` splices verbatim. */
  const q = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<Record<string, unknown>>> => {
    await ensure();
    let text = '';
    const params: unknown[] = [];
    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < values.length) {
        const v = values[i];
        if (isRaw(v)) {
          text += v.__raw;
        } else {
          params.push(v);
          text += dialect === 'postgres' ? `$${params.length}` : '?';
        }
      }
    }
    const { rows } = await client.query(text, params);
    return rows;
  };

  const rowToTenant = (r: Record<string, unknown>): Tenant => ({
    id: String(r['id']),
    name: String(r['name']),
    parentTenantId: r['parent_tenant_id'] == null ? null : String(r['parent_tenant_id']),
    path: String(r['path']),
    depth: Number(r['depth']),
    status: String(r['status']) as TenantStatus,
    metadata: parseJson(r['metadata']),
    createdAt: String(r['created_at']),
    updatedAt: String(r['updated_at']),
  });

  const getRow = async (id: string): Promise<Tenant | null> => {
    const rows = await q`SELECT * FROM ${T} WHERE id = ${id}`;
    return rows[0] ? rowToTenant(rows[0]) : null;
  };
  const requireRow = async (id: string): Promise<Tenant> => {
    const t = await getRow(id);
    if (!t) throw new TenantNotFoundError(id);
    return t;
  };

  const subtreeQuery = async (t: Tenant, includeSelf: boolean, sub?: SubtreeOptions): Promise<Tenant[]> => {
    await ensure();
    const like = `${escapeLikePrefix(t.path)}%`;
    const params: unknown[] = [like];
    const ph = (): string => (dialect === 'postgres' ? `$${params.length}` : '?');
    const where: string[] = [`path LIKE ${dialect === 'postgres' ? '$1' : '?'} ESCAPE '\\'`];
    if (!includeSelf) {
      params.push(t.path);
      where.push(`path <> ${ph()}`);
    }
    if (sub?.maxDepth != null) {
      params.push(t.depth + sub.maxDepth);
      where.push(`depth <= ${ph()}`);
    }
    if (sub?.statuses && sub.statuses.length > 0) {
      const marks = sub.statuses.map((s) => {
        params.push(s);
        return ph();
      });
      where.push(`status IN (${marks.join(', ')})`);
    }
    const { rows } = await client.query(
      `SELECT * FROM ${table} WHERE ${where.join(' AND ')} ORDER BY depth ASC, path ASC`,
      params,
    );
    return rows.map(rowToTenant);
  };

  const store: TenantHierarchyStore = {
    async create(input: CreateTenantInput) {
      const id = input.id ?? newId();
      assertUsableTenantId(id);
      if (await getRow(id)) throw new DuplicateTenantError(id);
      const parentTenantId = input.parentTenantId ?? null;
      const parent = parentTenantId == null ? null : await requireRow(parentTenantId);
      const path = buildPath(parent?.path ?? null, id);
      const ts = now();
      const meta = JSON.stringify(input.metadata ?? {});
      await q`INSERT INTO ${T} (id, name, parent_tenant_id, path, depth, status, metadata, created_at, updated_at)
              VALUES (${id}, ${input.name}, ${parentTenantId}, ${path}, ${depthOf(path)}, ${input.status ?? 'active'}, ${meta}, ${ts}, ${ts})`;
      return (await getRow(id))!;
    },
    async get(id) {
      return getRow(id);
    },
    async getByPath(path) {
      const rows = await q`SELECT * FROM ${T} WHERE path = ${path}`;
      return rows[0] ? rowToTenant(rows[0]) : null;
    },
    async roots() {
      const rows = await q`SELECT * FROM ${T} WHERE parent_tenant_id IS NULL ${ORDER}`;
      return rows.map(rowToTenant);
    },
    async children(id) {
      await requireRow(id);
      const rows = await q`SELECT * FROM ${T} WHERE parent_tenant_id = ${id} ${ORDER}`;
      return rows.map(rowToTenant);
    },
    async ancestors(id) {
      const t = await requireRow(id);
      const paths = ancestorPaths(t.path);
      if (paths.length === 0) return [];
      await ensure();
      const marks = paths.map((_, i) => (dialect === 'postgres' ? `$${i + 1}` : '?')).join(', ');
      const { rows } = await client.query(
        `SELECT * FROM ${table} WHERE path IN (${marks}) ORDER BY depth ASC, path ASC`,
        paths,
      );
      return rows.map(rowToTenant);
    },
    async descendants(id, sub) {
      return subtreeQuery(await requireRow(id), false, sub);
    },
    async subtree(id, sub) {
      return subtreeQuery(await requireRow(id), true, sub);
    },
    async reparent(id, newParentTenantId) {
      const t = await requireRow(id);
      const newParent = newParentTenantId == null ? null : await requireRow(newParentTenantId);
      if (wouldCreateCycle(t.path, newParent?.path ?? null)) throw new TenantCycleError(id, String(newParentTenantId));
      const oldRoot = t.path;
      const newRoot = buildPath(newParent?.path ?? null, id);
      if (newRoot === oldRoot) return t; // no-op
      const ts = now();
      const like = `${escapeLikePrefix(oldRoot)}%`;
      await q`UPDATE ${T}
              SET path = ${newRoot} || substr(path, ${oldRoot.length + 1}),
                  depth = depth + ${depthDelta(oldRoot, newRoot)},
                  parent_tenant_id = CASE WHEN id = ${id} THEN ${newParentTenantId} ELSE parent_tenant_id END,
                  updated_at = ${ts}
              WHERE path LIKE ${like} ${ESCAPE}`;
      return (await getRow(id))!;
    },
    async rename(id, name) {
      await requireRow(id);
      await q`UPDATE ${T} SET name = ${name}, updated_at = ${now()} WHERE id = ${id}`;
      return (await getRow(id))!;
    },
    async setStatus(id, status) {
      await requireRow(id);
      await q`UPDATE ${T} SET status = ${status}, updated_at = ${now()} WHERE id = ${id}`;
      return (await getRow(id))!;
    },
    async setMetadata(id, metadata) {
      const t = await requireRow(id);
      const merged = JSON.stringify({ ...t.metadata, ...metadata });
      await q`UPDATE ${T} SET metadata = ${merged}, updated_at = ${now()} WHERE id = ${id}`;
      return (await getRow(id))!;
    },
    async delete(id, del) {
      const t = await requireRow(id);
      const kids = await q`SELECT id FROM ${T} WHERE parent_tenant_id = ${id}`;
      if (kids.length > 0 && !del?.cascade) throw new TenantHasChildrenError(id);
      const like = `${escapeLikePrefix(t.path)}%`;
      await q`DELETE FROM ${T} WHERE path LIKE ${like} ${ESCAPE}`;
    },
    async count() {
      const rows = await q`SELECT count(*) AS c FROM ${T}`;
      return Number(rows[0]?.['c'] ?? 0);
    },
    async ensureDefault(input) {
      const id = input?.id ?? DEFAULT_TENANT_ID;
      const existing = await getRow(id);
      if (existing) return existing;
      try {
        return await store.create({ id, name: input?.name ?? 'Default' });
      } catch (e) {
        if (e instanceof DuplicateTenantError) return (await getRow(id))!;
        throw e;
      }
    },
  };

  return store;
}

function parseJson(v: unknown): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v === 'object') return v as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(v));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
