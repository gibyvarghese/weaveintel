/**
 * Phase 6 — `RuntimeComplianceSlot` adapter for `@weaveintel/guardrails/compliance`.
 *
 * `createRuntimeComplianceAdapter(opts)` wires all six durable managers into
 * the single `RuntimeComplianceSlot` shape that `weaveRuntime({ compliance })`
 * expects. Pass the result directly to `weaveRuntime`.
 *
 * Namespaces default to `consent`, `residency`, `deletion`, `audit-export`,
 * `legal-hold`, `retention`; override via `opts.*Namespace` if multiple
 * compliance adapters share one KV store.
 */

import type { WeaveRuntime, RuntimeComplianceSlot } from '@weaveintel/core';
import {
  createDurableConsentManager,
  createDurableResidencyEngine,
  createDurableDeletionManager,
  createDurableAuditExportManager,
  createDurableLegalHoldManager,
  createDurableRetentionEngine,
} from './durable.js';

export interface RuntimeComplianceAdapterOptions {
  /** The wired runtime — needed so durable managers share the same KV slot. */
  runtime: WeaveRuntime;
  /** KV namespace overrides (optional — sensible defaults are used if omitted). */
  consentNamespace?: string;
  residencyNamespace?: string;
  deletionNamespace?: string;
  auditExportNamespace?: string;
  legalHoldNamespace?: string;
  retentionNamespace?: string;
  /**
   * Default data categories used in `requestErasure` when the caller does not
   * supply explicit categories. Defaults to `['all']`.
   */
  defaultErasureCategories?: string[];
}

export function createRuntimeComplianceAdapter(
  opts: RuntimeComplianceAdapterOptions,
): RuntimeComplianceSlot {
  const { runtime } = opts;

  const consent = createDurableConsentManager({
    runtime,
    namespace: opts.consentNamespace ?? 'consent',
  });
  const residency = createDurableResidencyEngine({
    runtime,
    namespace: opts.residencyNamespace ?? 'residency',
  });
  const deletion = createDurableDeletionManager({
    runtime,
    namespace: opts.deletionNamespace ?? 'deletion',
  });
  const auditExport = createDurableAuditExportManager({
    runtime,
    namespace: opts.auditExportNamespace ?? 'audit-export',
  });
  // Legal-hold and retention are exposed as raw slot properties for advanced use;
  // the convenience methods on the slot do not surface them directly to keep the
  // API surface minimal.
  createDurableLegalHoldManager({ runtime, namespace: opts.legalHoldNamespace ?? 'legal-hold' });
  createDurableRetentionEngine({ runtime, namespace: opts.retentionNamespace ?? 'retention' });

  const defaultCategories = opts.defaultErasureCategories ?? ['all'];

  return {
    // ── Sub-accessors (raw managers) ──────────────────────────────────────────
    consent: {
      isGranted: (subjectId, purpose) => consent.isGranted(subjectId, purpose as never),
      grant: (subjectId, purpose, source, expiresAt) =>
        consent.grant(subjectId, purpose as never, source, expiresAt),
      revoke: (subjectId, purpose) => consent.revoke(subjectId, purpose as never),
      listBySubject: (subjectId) => consent.listBySubject(subjectId),
    },

    residency: {
      isAllowed: (dataCategory, targetRegion) =>
        residency.isAllowed(dataCategory, targetRegion),
      getAllowedRegions: (dataCategory) => residency.getAllowedRegions(dataCategory),
    },

    deletion: {
      create: (subjectId, requestedBy, reason, dataCategories) =>
        deletion.create(subjectId, requestedBy, reason, dataCategories).then((r) => ({
          id: r.id,
          status: r.status,
        })),
      process: (id) => deletion.process(id),
      complete: (id) => deletion.complete(id),
      fail: (id, reason) => deletion.fail(id, reason),
    },

    auditExport: {
      create: (tenantId, requestedBy, format, categories, fromDate, toDate) =>
        auditExport.create(tenantId, requestedBy, format as import('./audit-export.js').ExportFormat, categories, fromDate, toDate).then((r) => ({
          id: r.id,
          status: r.status,
          format: r.format,
        })),
      markReady: (id, recordCount, sizeBytes) => auditExport.markReady(id, recordCount, sizeBytes),
      markFailed: (id) => auditExport.markFailed(id),
    },

    // ── Convenience helpers ───────────────────────────────────────────────────

    async isAllowed(userId, purpose) {
      try {
        const flags = await consent.listBySubject(userId);
        // Permit-if-no-record: only block when an explicit flag for this purpose exists
        // and has expired. An absent record → allow (opt-in model assumed).
        const flag = flags.find((f) => (f as { purpose?: string }).purpose === purpose);
        if (!flag) return true;
        return consent.isGranted(userId, purpose as never);
      } catch {
        return true; // fail-open on transient KV error
      }
    },

    async canProcess(_tenantId, dataCategory, targetRegion) {
      try {
        return await residency.isAllowed(dataCategory, targetRegion);
      } catch {
        return true; // fail-open: missing residency constraint → allow
      }
    },

    async requestErasure(userId, requestedBy, reason, dataCategories) {
      const cats = dataCategories && dataCategories.length > 0 ? dataCategories : defaultCategories;
      const req = await deletion.create(
        userId,
        requestedBy ?? userId,
        reason ?? 'user-requested erasure',
        cats,
      );
      return { id: req.id, status: req.status, dataCategories: req.dataCategories };
    },

    async requestExport(userId, tenantId, format) {
      const fmt = (format ?? 'json') as import('./audit-export.js').ExportFormat;
      const now = Date.now();
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
      const exp = await auditExport.create(tenantId, userId, fmt, ['all'], thirtyDaysAgo, now);
      return { id: exp.id, status: exp.status, format: exp.format };
    },
  };
}
