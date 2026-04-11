import { randomUUID } from 'node:crypto';
import type { Artifact, ArtifactPolicy, ArtifactType } from '@weaveintel/core';
import { estimateSize } from './artifact.js';

const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Options for creating an ArtifactPolicy.
 */
export interface CreateArtifactPolicyOptions {
  name: string;
  maxSizeBytes?: number;
  allowedTypes?: ArtifactType[];
  retentionDays?: number;
  requireVersioning?: boolean;
  enabled?: boolean;
}

/**
 * Create an ArtifactPolicy with sensible defaults.
 */
export function createArtifactPolicy(opts: CreateArtifactPolicyOptions): ArtifactPolicy {
  return {
    id: randomUUID(),
    name: opts.name,
    maxSizeBytes: opts.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES,
    allowedTypes: opts.allowedTypes, // undefined ⇒ all types allowed
    retentionDays: opts.retentionDays ?? DEFAULT_RETENTION_DAYS,
    requireVersioning: opts.requireVersioning ?? true,
    enabled: opts.enabled ?? true,
  };
}

/**
 * Validation result.
 */
export interface ValidationResult {
  valid: boolean;
  violations: string[];
}

/**
 * Validate an artifact against a policy.
 */
export function validateArtifact(artifact: Artifact, policy: ArtifactPolicy): ValidationResult {
  const violations: string[] = [];

  if (!policy.enabled) {
    return { valid: true, violations };
  }

  // Size check
  if (policy.maxSizeBytes !== undefined) {
    const size = artifact.sizeBytes ?? estimateSize(artifact.data);
    if (size > policy.maxSizeBytes) {
      violations.push(
        `Artifact size (${size} bytes) exceeds maximum allowed (${policy.maxSizeBytes} bytes)`,
      );
    }
  }

  // Type check
  if (policy.allowedTypes && policy.allowedTypes.length > 0) {
    if (!policy.allowedTypes.includes(artifact.type)) {
      violations.push(
        `Artifact type '${artifact.type}' is not in the allowed types: ${policy.allowedTypes.join(', ')}`,
      );
    }
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Check whether an artifact has exceeded the policy retention period.
 */
export function isExpired(artifact: Artifact, policy: ArtifactPolicy): boolean {
  if (policy.retentionDays === undefined || policy.retentionDays <= 0) {
    return false;
  }

  const created = new Date(artifact.createdAt).getTime();
  const now = Date.now();
  const retentionMs = policy.retentionDays * 24 * 60 * 60 * 1000;

  return now - created > retentionMs;
}
