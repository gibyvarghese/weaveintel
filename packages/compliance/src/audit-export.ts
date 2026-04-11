// @weaveintel/compliance — Tenant-level audit export

export type ExportFormat = 'json' | 'csv' | 'ndjson';
export type ExportStatus = 'pending' | 'generating' | 'ready' | 'expired' | 'failed';

export interface AuditExport {
  readonly id: string;
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly format: ExportFormat;
  readonly status: ExportStatus;
  readonly dataCategories: readonly string[];
  readonly fromDate: number;
  readonly toDate: number;
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly recordCount: number;
  readonly sizeBytes: number;
}

export interface AuditExportManager {
  create(tenantId: string, requestedBy: string, format: ExportFormat, categories: string[], fromDate: number, toDate: number): AuditExport;
  get(id: string): AuditExport | undefined;
  list(tenantId: string): readonly AuditExport[];
  markReady(id: string, recordCount: number, sizeBytes: number): AuditExport | undefined;
  markFailed(id: string): AuditExport | undefined;
}

export function createAuditExportManager(): AuditExportManager {
  const exports = new Map<string, AuditExport>();

  function nextId(): string {
    return `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  return {
    create(tenantId, requestedBy, format, categories, fromDate, toDate) {
      const exp: AuditExport = {
        id: nextId(), tenantId, requestedBy, format, status: 'pending',
        dataCategories: categories, fromDate, toDate,
        createdAt: Date.now(), completedAt: null, recordCount: 0, sizeBytes: 0,
      };
      exports.set(exp.id, exp);
      return exp;
    },
    get(id) { return exports.get(id); },
    list(tenantId) { return Array.from(exports.values()).filter((e) => e.tenantId === tenantId); },
    markReady(id, recordCount, sizeBytes) {
      const existing = exports.get(id);
      if (!existing) return undefined;
      const updated: AuditExport = { ...existing, status: 'ready', recordCount, sizeBytes, completedAt: Date.now() };
      exports.set(id, updated);
      return updated;
    },
    markFailed(id) {
      const existing = exports.get(id);
      if (!existing) return undefined;
      const updated: AuditExport = { ...existing, status: 'failed', completedAt: Date.now() };
      exports.set(id, updated);
      return updated;
    },
  };
}
