/**
 * @weaveintel/encryption — audit emitter contract.
 *
 * Every key lifecycle and crypto operation emits one audit record. Hosts
 * persist these to the `encryption_audit` table (or equivalent).
 */

export type EncryptionAuditKind =
  | 'kek_create'
  | 'kek_rotate'
  | 'kek_revoke'
  | 'dek_create'
  | 'dek_rotate'
  | 'dek_revoke'
  | 'bik_create'
  | 'bik_rotate'
  | 'bik_revoke'
  | 'bidx_compute'
  | 'bidx_rebuild'
  | 'wrap'
  | 'unwrap'
  | 'shred'
  | 'policy_change'
  | 'rewrite_progress'
  | 'tenant_bootstrap'
  | 'tenant_deletion_requested'
  | 'tenant_deletion_cancelled'
  | 'tenant_restored'
  | 'tenant_purged'
  | 'kms_health_check'
  | 'compliance_report_generated'
  | 'byok_register'
  | 'byok_rotate_pubkey'
  | 'byok_revoke'
  | 'hyok_unwrap'
  | 'break_glass_requested'
  | 'break_glass_approved'
  | 'break_glass_denied'
  | 'break_glass_consumed'
  | 'break_glass_expired'
  | 'attestation_generated'
  | 'attestation_verified';

export interface EncryptionAuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly eventKind: EncryptionAuditKind;
  readonly actor: string | null;
  readonly details: Record<string, unknown> | null;
  readonly createdAt: number;
}

export interface AuditEmitter {
  emit(event: EncryptionAuditEvent): Promise<void>;
}

export const noopAuditEmitter: AuditEmitter = {
  async emit(): Promise<void> {
    /* no-op */
  },
};
