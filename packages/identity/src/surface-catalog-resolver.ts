/**
 * @weaveintel/identity — Surface catalog resolver
 *
 * Implements `SurfaceCatalogResolver` from `@weaveintel/core`.
 *
 * Responsibilities:
 *  - Fans out to N `CatalogSource`s in parallel
 *  - Runs each entry through an optional `accessCheck` — fail-closed
 *    (error → exclude + log, never throw into caller)
 *  - Caches resolved catalogs per (principalId, surfaceId, tenantId) with a
 *    short in-memory TTL (injectable)
 *  - Emits a `catalog.resolved` observability span (entry counts only, no PII)
 */

import type {
  ExecutionContext,
  SurfaceCatalog,
  SurfaceCatalogRequest,
  SurfaceCatalogResolver,
  CatalogEntry,
} from '@weaveintel/core';

// ---------------------------------------------------------------------------
// CatalogSource — supplied by the app
// ---------------------------------------------------------------------------

/**
 * A source that provides catalog entries for a given principal and surface.
 * Multiple sources are fanned out in parallel; each may return zero or more
 * entries.  Errors from any source are caught, logged, and skipped (the rest
 * of the catalog is still returned).
 */
export interface CatalogSource {
  /**
   * Unique name for this source (used in observability + error logs).
   * Examples: `'tool-catalog'`, `'live-agents'`, `'mode-definitions'`.
   */
  readonly name: string;
  /**
   * Fetch entries for the given context and surface.
   * Must never throw — wrap internal errors and return `[]` on failure.
   * (The resolver also guards with a try/catch for defense-in-depth.)
   */
  entries(ctx: ExecutionContext, req: SurfaceCatalogRequest): Promise<CatalogEntry[]>;
}

// ---------------------------------------------------------------------------
// AccessCheck
// ---------------------------------------------------------------------------

/**
 * Optional per-entry gating function.
 * Return `true` to include the entry, `false` to exclude it.
 * Throwing counts as `false` (fail-closed).
 */
export type AccessCheck = (ctx: ExecutionContext, entry: CatalogEntry) => boolean | Promise<boolean>;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** Overridable cache interface for tests. */
export interface CatalogCache {
  get(key: string): SurfaceCatalog | undefined;
  set(key: string, value: SurfaceCatalog, ttlMs: number): void;
}

/** Simple in-memory TTL cache (default). */
function createInMemoryCache(): CatalogCache {
  const store = new Map<string, { value: SurfaceCatalog; expiresAt: number }>();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry || entry.expiresAt < Date.now()) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SurfaceCatalogResolverOptions {
  /**
   * One or more sources to fan out to.
   * Each source's errors are caught and skipped.
   */
  sources: CatalogSource[];
  /**
   * Optional per-entry access gate.
   * Entries that fail the check (or throw) are excluded.
   * When omitted, all entries are included.
   */
  accessCheck?: AccessCheck;
  /**
   * Cache TTL in milliseconds (default: 30 000 — 30 seconds).
   * Set to 0 to disable caching.
   */
  cacheTtlMs?: number;
  /**
   * Inject a custom cache implementation (useful in tests).
   */
  cache?: CatalogCache;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSurfaceCatalogResolver(opts: SurfaceCatalogResolverOptions): SurfaceCatalogResolver {
  const {
    sources,
    accessCheck,
    cacheTtlMs = 30_000,
    cache = cacheTtlMs > 0 ? createInMemoryCache() : null,
  } = opts;

  return {
    async resolve(ctx: ExecutionContext, req: SurfaceCatalogRequest): Promise<SurfaceCatalog> {
      const principalId = ctx.userId ?? '__anonymous__';
      const tenantId = ctx.tenantId ?? '__global__';
      const cacheKey = `${tenantId}::${principalId}::${req.surfaceId}`;

      // Cache hit
      if (cache) {
        const cached = cache.get(cacheKey);
        if (cached) return cached;
      }

      // Fan out to all sources in parallel — catch each independently
      const sourcedEntries = await Promise.all(
        sources.map(async (src) => {
          try {
            return await src.entries(ctx, req);
          } catch (err) {
            if (ctx.tracer) {
              const sp = ctx.tracer.startSpan(ctx, `catalog.source.error`, { sourceName: src.name, error: String(err) });
              sp.end();
            }
            return [] as CatalogEntry[];
          }
        }),
      );
      const allEntries = sourcedEntries.flat();

      // Apply access check — fail-closed
      let filtered: CatalogEntry[];
      if (accessCheck) {
        const results = await Promise.all(
          allEntries.map(async (entry) => {
            try {
              const allowed = await accessCheck(ctx, entry);
              return allowed ? entry : null;
            } catch (err) {
              if (ctx.tracer) {
                const sp = ctx.tracer.startSpan(ctx, `catalog.access.error`, { entryId: entry.id, error: String(err) });
                sp.end();
              }
              return null;
            }
          }),
        );
        filtered = results.filter((e): e is CatalogEntry => e !== null);
      } else {
        filtered = allEntries;
      }

      const resolvedAt = new Date().toISOString();
      const catalog: SurfaceCatalog = {
        surfaceId: req.surfaceId,
        entries: filtered,
        resolvedAt,
      };

      // Emit observability span (entry counts only — no PII)
      if (ctx.tracer) {
        const sp = ctx.tracer.startSpan(ctx, 'catalog.resolved', {
          surfaceId: req.surfaceId,
          totalEntries: filtered.length,
          sourcesQueried: sources.length,
        });
        sp.end();
      }

      // Cache result
      if (cache && cacheTtlMs > 0) {
        cache.set(cacheKey, catalog, cacheTtlMs);
      }

      return catalog;
    },
  };
}
