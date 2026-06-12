/**
 * @weaveintel/core — Surface catalog contracts
 *
 * A *surface* is a specific client context (mobile, desktop, web, voice, …).
 * The surface catalog tells a client which capabilities (modes, agents, models,
 * skills, tools) are available to a particular principal on a particular surface.
 *
 * The resolver lives in `@weaveintel/identity`; sources are supplied by the app.
 *
 * Vocabulary rule: no "chat" / "conversation" / "message" / "turn" vocabulary.
 */

import type { ExecutionContext } from './context.js';

// ─── Request ──────────────────────────────────────────────────────────────────

/**
 * Input to a surface catalog resolution.
 * `surfaceId` is app-defined (e.g. `'mobile'`, `'desktop'`, `'web'`).
 */
export interface SurfaceCatalogRequest {
  readonly surfaceId: string;
}

// ─── Entry ────────────────────────────────────────────────────────────────────

/**
 * A single capability entry in the catalog.
 *
 * Entries are resolved from DB-backed sources and filtered by the access-check
 * policy in the resolver.  Entries that fail the access check are excluded; the
 * error is logged but never surfaced to the caller (fail-closed).
 */
export interface CatalogEntry {
  /** Stable unique identifier for this entry within the tenant. */
  readonly id: string;
  /**
   * Discriminant used by clients to render the correct UI affordance.
   * - `mode`    — an operating mode (e.g. "Assistant", "Agent", "Team").
   * - `agent`   — a named live-agent configuration.
   * - `model`   — a model deployment the principal may select.
   * - `skill`   — a reusable skill pack.
   * - `tool`    — a tool from the operator tool catalog.
   * - `custom`  — application-defined; clients use `metadata` for rendering hints.
   */
  readonly kind: 'mode' | 'agent' | 'model' | 'skill' | 'tool' | 'custom';
  /** Human-readable display name. */
  readonly label: string;
  /** Optional short description for tooltips / onboarding. */
  readonly description?: string;
  /** Whether this entry should be pre-selected when the surface opens. */
  readonly default?: boolean;
  /** Arbitrary app-defined hints (icon, color, feature flags, etc.). */
  readonly metadata?: Record<string, unknown>;
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

/**
 * The resolved catalog for a specific principal + surface combination.
 */
export interface SurfaceCatalog {
  readonly surfaceId: string;
  readonly entries: readonly CatalogEntry[];
  /** ISO-8601 timestamp of resolution — used for cache TTL display. */
  readonly resolvedAt: string;
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Implemented by `@weaveintel/identity` `createSurfaceCatalogResolver(...)`.
 *
 * Callers supply the `ExecutionContext` (for principal + tenant scoping) and a
 * `SurfaceCatalogRequest`; the resolver handles filtering, caching, and emitting
 * the `catalog.resolved` observability event.
 */
export interface SurfaceCatalogResolver {
  resolve(ctx: ExecutionContext, req: SurfaceCatalogRequest): Promise<SurfaceCatalog>;
}
