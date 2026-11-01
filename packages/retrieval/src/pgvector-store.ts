// SPDX-License-Identifier: MIT
/**
 * A PostgreSQL + pgvector `VectorStore` whose `search` needs a verified principal (GAPS G-WI-18).
 *
 * --- For someone new to this ---
 * Semantic search must never become a cross-tenant read or a read above someone's clearance. A
 * vector store that takes "a tenant id filter" from its caller trusts whoever builds the filter —
 * often code that took it from a model's arguments. This store refuses to search without a
 * *verified* principal:
 *
 *   - `search(ctx, { principal, embedding, topK })` — no principal, or one the configured
 *     `verifyPrincipal` rejects, throws `PrincipalRequiredError`. The principal's tenant must
 *     equal the server-owned `ctx.tenantId`.
 *   - Every row carries `tenant_id`, an `acl` (subjects or groups allowed; `*` = anyone in the
 *     tenant) and a numeric `classification`. The SQL itself keeps only rows in the principal's
 *     tenant, whose ACL names the principal or one of its groups, and whose classification is at
 *     or below the principal's clearance. An empty ACL matches nobody.
 *   - Writes and deletes are scoped to `ctx.tenantId`; a row without an ACL is refused.
 *   - Optionally the store sets a transaction-local tenant setting (`rlsTenantSetting`) so the
 *     database's row-level-security policies apply too.
 *
 * `createPrincipalSeal(secret)` is one way to mint and verify principals (an HMAC over the
 * claims with an expiry); a host with its own identity layer passes its own `verifyPrincipal`.
 *
 * The store takes the host's `pg` pool (anything with `query`, and `connect` for the RLS mode),
 * so this package does not depend on `pg`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ExecutionContext,
  VectorRecord,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
  VectorStoreConfig,
} from '@weaveintel/core';
import { Capabilities, weaveCapabilities } from '@weaveintel/core';

/** Who is searching, as established by the host's identity layer — never by a model. */
export interface VerifiedPrincipal {
  readonly tenantId: string;
  /** The person's or agent's stable id. */
  readonly subject: string;
  /** Groups / roles the ACL may name. */
  readonly groups?: readonly string[];
  /** Highest classification the principal may read. Default 0. */
  readonly clearance?: number;
  /** Opaque proof checked by `verifyPrincipal` (e.g. the seal from `createPrincipalSeal`). */
  readonly proof?: string;
  /** ISO-8601 expiry, when the proof has one. */
  readonly expiresAt?: string;
}

export interface PrincipalVectorSearchOptions extends VectorSearchOptions {
  /** Required. Search refuses to run without it. */
  readonly principal: VerifiedPrincipal;
}

/** Minimal `pg` client surface the store needs. */
export interface PgQueryable {
  query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}
/** A pool that can hand out a dedicated client (needed for the transaction-local RLS setting). */
export interface PgPoolLike extends PgQueryable {
  connect?(): Promise<PgQueryable & { release(): void }>;
}

export interface PgVectorStoreOptions {
  readonly pool: PgPoolLike;
  readonly dimensions: number;
  /** Table name (letters, digits, underscores; optionally `schema.table`). Default `wi_vector`. */
  readonly table?: string;
  readonly metric?: 'cosine' | 'euclidean' | 'dotProduct';
  readonly name?: string;
  /**
   * Required. Confirms a principal is genuine (signature, expiry, revocation). Return false to
   * refuse. There is no default: a store that believed any principal would fail open.
   */
  readonly verifyPrincipal: (ctx: ExecutionContext, principal: VerifiedPrincipal) => boolean | Promise<boolean>;
  /**
   * A Postgres setting (e.g. `app.tenant_id`) to set, transaction-local, to the principal's tenant
   * before each read and write, so RLS policies keyed on it apply. Needs `pool.connect`.
   */
  readonly rlsTenantSetting?: string;
  /** Largest `topK` honoured. Default 200. */
  readonly maxTopK?: number;
}

export class PrincipalRequiredError extends Error {
  constructor(reason: string) {
    super(`Vector search refused: ${reason}`);
    this.name = 'PrincipalRequiredError';
  }
}

export interface PgVectorStore extends VectorStore {
  search(ctx: ExecutionContext, options: PrincipalVectorSearchOptions): Promise<VectorSearchResult[]>;
  /** Create the extension (if allowed), table and indexes. Safe to run repeatedly. */
  ensureSchema(): Promise<void>;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}(?:\.[A-Za-z_][A-Za-z0-9_]{0,62})?$/;
const SETTING_RE = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;

function metricSql(metric: PgVectorStoreOptions['metric']): { op: string; ops: string; score: (d: string) => string } {
  switch (metric ?? 'cosine') {
    case 'euclidean':
      return { op: '<->', ops: 'vector_l2_ops', score: (d) => `(1.0 / (1.0 + ${d}))` };
    case 'dotProduct':
      return { op: '<#>', ops: 'vector_ip_ops', score: (d) => `(-(${d}))` };
    default:
      return { op: '<=>', ops: 'vector_cosine_ops', score: (d) => `(1.0 - ${d})` };
  }
}

function vectorLiteral(embedding: readonly number[], dims: number): string {
  if (embedding.length !== dims) throw new Error(`embedding has ${embedding.length} dimensions, expected ${dims}`);
  for (const x of embedding) if (!Number.isFinite(x)) throw new Error('embedding contains a non-finite value');
  return `[${embedding.join(',')}]`;
}

export function weavePgVectorStore(opts: PgVectorStoreOptions): PgVectorStore {
  if (typeof opts?.verifyPrincipal !== 'function') {
    throw new PrincipalRequiredError('the store needs a verifyPrincipal function');
  }
  const table = opts.table ?? 'wi_vector';
  if (!IDENT_RE.test(table)) throw new Error(`invalid table name ${JSON.stringify(table)}`);
  if (opts.rlsTenantSetting !== undefined && !SETTING_RE.test(opts.rlsTenantSetting)) {
    throw new Error(`invalid RLS setting name ${JSON.stringify(opts.rlsTenantSetting)}`);
  }
  if (opts.rlsTenantSetting && typeof opts.pool.connect !== 'function') {
    throw new Error('rlsTenantSetting needs a pool with connect()');
  }
  if (!Number.isInteger(opts.dimensions) || opts.dimensions < 1 || opts.dimensions > 16000) {
    throw new Error('dimensions must be an integer between 1 and 16000');
  }
  const dims = opts.dimensions;
  const maxTopK = opts.maxTopK ?? 200;
  const m = metricSql(opts.metric);
  const config: VectorStoreConfig = {
    name: opts.name ?? `pgvector:${table}`,
    dimensions: dims,
    metric: opts.metric ?? 'cosine',
  };

  /** Runs `fn` with the tenant setting applied when RLS mode is on. */
  async function withTenant<R>(tenantId: string, fn: (db: PgQueryable) => Promise<R>): Promise<R> {
    if (!opts.rlsTenantSetting) return fn(opts.pool);
    const client = await opts.pool.connect!();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', [opts.rlsTenantSetting, tenantId]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* the original error matters more */ }
      throw err;
    } finally {
      client.release();
    }
  }

  function requireTenant(ctx: ExecutionContext): string {
    const t = ctx.tenantId;
    if (typeof t !== 'string' || t.length === 0) throw new PrincipalRequiredError('the context has no tenant');
    return t;
  }

  async function checkPrincipal(ctx: ExecutionContext, principal: VerifiedPrincipal | undefined): Promise<VerifiedPrincipal> {
    if (!principal || typeof principal !== 'object') throw new PrincipalRequiredError('no principal');
    const tenantId = requireTenant(ctx);
    if (principal.tenantId !== tenantId) throw new PrincipalRequiredError("the principal's tenant does not match the context");
    if (typeof principal.subject !== 'string' || principal.subject.length === 0) throw new PrincipalRequiredError('the principal has no subject');
    let ok = false;
    try {
      ok = (await opts.verifyPrincipal(ctx, principal)) === true;
    } catch {
      ok = false;
    }
    if (!ok) throw new PrincipalRequiredError('the principal could not be verified');
    return principal;
  }

  return {
    config,
    ...weaveCapabilities(Capabilities.VectorSearch),

    async ensureSchema() {
      await opts.pool.query('CREATE EXTENSION IF NOT EXISTS vector').catch(() => undefined);
      const base = table.includes('.') ? table.split('.')[1]! : table;
      await opts.pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
        tenant_id text NOT NULL,
        id text NOT NULL,
        embedding vector(${dims}) NOT NULL,
        content text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        acl text[] NOT NULL,
        classification integer NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, id)
      )`);
      await opts.pool.query(`CREATE INDEX IF NOT EXISTS ${base}_embedding_idx ON ${table} USING hnsw (embedding ${m.ops})`);
      await opts.pool.query(`CREATE INDEX IF NOT EXISTS ${base}_acl_idx ON ${table} USING gin (acl)`);
    },

    async upsert(ctx, records: VectorRecord[]) {
      const tenantId = requireTenant(ctx);
      if (records.length === 0) return;
      const rows = records.map((r) => {
        const acl = r.metadata?.['acl'];
        if (!Array.isArray(acl) || acl.length === 0 || !acl.every((a) => typeof a === 'string' && a.length > 0)) {
          throw new Error(`vector record ${JSON.stringify(r.id)} needs metadata.acl: a non-empty list of subjects or groups`);
        }
        const cls = r.metadata?.['classification'] ?? 0;
        if (typeof cls !== 'number' || !Number.isInteger(cls) || cls < 0) {
          throw new Error(`vector record ${JSON.stringify(r.id)} has an invalid classification`);
        }
        const { acl: _a, classification: _c, ...rest } = r.metadata ?? {};
        return { id: r.id, embedding: vectorLiteral(r.embedding, dims), content: r.content, metadata: JSON.stringify(rest), acl, cls };
      });
      await withTenant(tenantId, async (db) => {
        for (const row of rows) {
          await db.query(
            `INSERT INTO ${table} (tenant_id, id, embedding, content, metadata, acl, classification, updated_at)
             VALUES ($1, $2, $3::vector, $4, $5::jsonb, $6::text[], $7, now())
             ON CONFLICT (tenant_id, id) DO UPDATE SET embedding = EXCLUDED.embedding, content = EXCLUDED.content,
               metadata = EXCLUDED.metadata, acl = EXCLUDED.acl, classification = EXCLUDED.classification, updated_at = now()`,
            [tenantId, row.id, row.embedding, row.content, row.metadata, row.acl, row.cls],
          );
        }
      });
    },

    async search(ctx, options) {
      const principal = await checkPrincipal(ctx, (options as Partial<PrincipalVectorSearchOptions>)?.principal);
      const topK = Math.max(1, Math.min(maxTopK, Math.floor(options.topK || 0) || 1));
      const vec = vectorLiteral(options.embedding, dims);
      const allowed = ['*', principal.subject, ...(principal.groups ?? [])];
      const clearance = Number.isInteger(principal.clearance) && (principal.clearance ?? 0) >= 0 ? principal.clearance! : 0;
      const params: unknown[] = [vec, principal.tenantId, allowed, clearance];
      let filterSql = '';
      if (options.filter && Object.keys(options.filter).length > 0) {
        params.push(JSON.stringify(options.filter));
        filterSql = ` AND metadata @> $${params.length}::jsonb`;
      }
      let minScoreSql = '';
      if (typeof options.minScore === 'number' && Number.isFinite(options.minScore)) {
        params.push(options.minScore);
        minScoreSql = ` AND ${m.score(`(embedding ${m.op} $1::vector)`)} >= $${params.length}`;
      }
      params.push(topK);
      const sql = `SELECT id, content, metadata, ${m.score(`(embedding ${m.op} $1::vector)`)} AS score
        FROM ${table}
        WHERE tenant_id = $2 AND acl && $3::text[] AND classification <= $4${filterSql}${minScoreSql}
        ORDER BY embedding ${m.op} $1::vector
        LIMIT $${params.length}`;
      const { rows } = await withTenant(principal.tenantId, (db) =>
        db.query<{ id: string; content: string; metadata: Record<string, unknown> | string; score: number | string }>(sql, params),
      );
      return rows.map((r) => ({
        id: r.id,
        content: r.content,
        score: Number(r.score),
        metadata: options.includeMetadata === false ? {} : (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) ?? {},
      }));
    },

    async delete(ctx, ids) {
      const tenantId = requireTenant(ctx);
      if (ids.length === 0) return;
      await withTenant(tenantId, (db) => db.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND id = ANY($2::text[])`, [tenantId, ids]));
    },

    async count(ctx) {
      const tenantId = requireTenant(ctx);
      const { rows } = await withTenant(tenantId, (db) =>
        db.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1`, [tenantId]),
      );
      return Number(rows[0]?.n ?? 0);
    },
  };
}

// ─── Principal seal (one way to mint verifiable principals) ──────────────────

function canonicalClaims(p: VerifiedPrincipal): string {
  return JSON.stringify([p.tenantId, p.subject, [...(p.groups ?? [])].sort(), p.clearance ?? 0, p.expiresAt ?? '']);
}

/**
 * HMAC seal for principals. `seal` signs the claims (with an expiry); `verify` checks the
 * signature in constant time and the expiry. Keep the secret server-side; anything that can't
 * read it can't mint a principal the store accepts.
 */
export function createPrincipalSeal(secret: string | Buffer, opts: { ttlSeconds?: number; now?: () => Date } = {}) {
  if ((typeof secret === 'string' ? Buffer.byteLength(secret) : secret.length) < 32) {
    throw new Error('principal seal secret must be at least 32 bytes');
  }
  const now = opts.now ?? (() => new Date());
  const ttl = opts.ttlSeconds ?? 300;
  const mac = (p: VerifiedPrincipal) => createHmac('sha256', secret).update(canonicalClaims(p)).digest('base64url');
  return {
    seal(claims: Omit<VerifiedPrincipal, 'proof' | 'expiresAt'>): VerifiedPrincipal {
      const p: VerifiedPrincipal = { ...claims, expiresAt: new Date(now().getTime() + ttl * 1000).toISOString() };
      return { ...p, proof: mac(p) };
    },
    verify(p: VerifiedPrincipal): boolean {
      if (!p.proof || !p.expiresAt) return false;
      const exp = Date.parse(p.expiresAt);
      if (!Number.isFinite(exp) || exp <= now().getTime()) return false;
      const want = Buffer.from(mac(p));
      const got = Buffer.from(p.proof);
      return want.length === got.length && timingSafeEqual(want, got);
    },
  };
}
