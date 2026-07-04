// SPDX-License-Identifier: MIT
// @weaveintel/guardrails/compliance — Public API

// Domain error classes (L-27+A-6)
export {
  LegalHoldActiveError,
  ConsentExpiredError,
  ResidencyViolationError,
} from './errors.js';
export {
  type RetentionAction,
  type RetentionRule,
  type RetentionEngine,
  createRetentionEngine,
} from './retention.js';

export {
  type DeletionStatus,
  type DeletionRequest,
  type DeletionManager,
  createDeletionManager,
} from './deletion.js';

export {
  type LegalHoldStatus,
  type LegalHold,
  type LegalHoldManager,
  createLegalHoldManager,
} from './legal-hold.js';

export {
  type ResidencyConstraint,
  type ResidencyEngine,
  createResidencyEngine,
} from './residency.js';

export {
  type ConsentPurpose,
  type ConsentFlag,
  type ConsentManager,
  createConsentManager,
} from './consent.js';

export {
  type ExportFormat,
  type ExportStatus,
  type AuditExport,
  type AuditExportManager,
  createAuditExportManager,
} from './audit-export.js';

// Phase 6 — RuntimeComplianceSlot adapter for weaveRuntime({ compliance }).
export {
  createRuntimeComplianceAdapter,
  type RuntimeComplianceAdapterOptions,
} from './runtime-compliance-adapter.js';

// Phase 4 — durable variants backed by `runtime.persistence.kv`.
export {
  type DurableLegalHoldManager,
  createDurableLegalHoldManager,
  type DurableConsentManager,
  createDurableConsentManager,
  type DurableResidencyEngine,
  type DurableResidencyEngineOpts,
  createDurableResidencyEngine,
  type DurableRetentionEngine,
  createDurableRetentionEngine,
  type DurableAuditExportManager,
  createDurableAuditExportManager,
  type DurableDeletionManager,
  createDurableDeletionManager,
} from './durable.js';
