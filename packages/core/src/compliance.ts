/**
 * @weaveintel/core — Compliance contracts
 */

// ─── Compliance Policy ───────────────────────────────────────

export interface CompliancePolicy {
  id: string;
  name: string;
  description?: string;
  type: 'retention' | 'deletion' | 'residency' | 'consent' | 'audit';
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt?: string;
}

// ─── Retention ───────────────────────────────────────────────

export interface RetentionRule {
  id: string;
  name: string;
  dataType: string;
  retentionDays: number;
  action: 'delete' | 'archive' | 'anonymize';
  scope?: string;
  enabled: boolean;
}

// ─── Deletion ────────────────────────────────────────────────

export type DeletionStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'held';

export interface DeletionRequest {
  id: string;
  requestedBy: string;
  targetUserId?: string;
  targetTenantId?: string;
  dataTypes: string[];
  status: DeletionStatus;
  reason: string;
  createdAt: string;
  completedAt?: string;
}

// ─── Legal Hold ──────────────────────────────────────────────

export interface LegalHold {
  id: string;
  name: string;
  scope: string;
  reason: string;
  active: boolean;
  createdBy: string;
  createdAt: string;
  releasedAt?: string;
}

// ─── Residency ───────────────────────────────────────────────

export interface ResidencyConstraint {
  id: string;
  name: string;
  allowedRegions: string[];
  deniedRegions: string[];
  dataTypes: string[];
  tenantId?: string;
}

// ─── Audit ───────────────────────────────────────────────────

export interface AuditExport {
  id: string;
  tenantId: string;
  fromDate: string;
  toDate: string;
  format: 'json' | 'csv';
  status: 'pending' | 'generating' | 'ready' | 'expired';
  downloadUrl?: string;
  createdAt: string;
}

// ─── Consent ─────────────────────────────────────────────────

export interface ConsentFlag {
  id: string;
  userId: string;
  purpose: string;
  granted: boolean;
  grantedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
}
