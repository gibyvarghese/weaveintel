/**
 * @weaveintel/sandbox — Policy management
 */

import type { SandboxPolicy, ExecutionLimits } from '@weaveintel/core';
import { randomUUID } from 'node:crypto';
import { createDefaultLimits } from './limits.js';

export interface CreatePolicyOptions {
  name?: string;
  limits?: Partial<ExecutionLimits>;
  allowedModules?: string[];
  deniedModules?: string[];
  networkAccess?: boolean;
  fileSystemAccess?: 'none' | 'read-only' | 'read-write';
  enabled?: boolean;
}

export function createSandboxPolicy(opts: CreatePolicyOptions = {}): SandboxPolicy {
  const defaults = createDefaultLimits();
  const limits: ExecutionLimits = {
    maxDurationMs: opts.limits?.maxDurationMs ?? defaults.maxDurationMs,
    maxCpuMs: opts.limits?.maxCpuMs ?? defaults.maxCpuMs,
    maxMemoryMb: opts.limits?.maxMemoryMb ?? defaults.maxMemoryMb,
    maxOutputBytes: opts.limits?.maxOutputBytes ?? defaults.maxOutputBytes,
    maxFileSize: opts.limits?.maxFileSize ?? defaults.maxFileSize,
  };

  return {
    id: randomUUID(),
    name: opts.name ?? 'default',
    limits,
    allowedModules: opts.allowedModules,
    deniedModules: opts.deniedModules,
    networkAccess: opts.networkAccess ?? false,
    fileSystemAccess: opts.fileSystemAccess ?? 'none',
    enabled: opts.enabled ?? true,
  };
}

export function validatePolicy(policy: SandboxPolicy): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!policy.id) errors.push('Policy must have an id');
  if (!policy.name) errors.push('Policy must have a name');

  const lim = policy.limits;
  if (lim.maxDurationMs <= 0) errors.push('maxDurationMs must be positive');
  if (lim.maxCpuMs !== undefined && lim.maxCpuMs <= 0) errors.push('maxCpuMs must be positive');
  if (lim.maxMemoryMb !== undefined && lim.maxMemoryMb <= 0) errors.push('maxMemoryMb must be positive');
  if (lim.maxOutputBytes !== undefined && lim.maxOutputBytes <= 0) errors.push('maxOutputBytes must be positive');
  if (lim.maxFileSize !== undefined && lim.maxFileSize <= 0) errors.push('maxFileSize must be positive');

  if (policy.allowedModules && policy.deniedModules) {
    const overlap = policy.allowedModules.filter((m) => policy.deniedModules!.includes(m));
    if (overlap.length > 0) {
      errors.push(`Modules both allowed and denied: ${overlap.join(', ')}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function mergePolicies(base: SandboxPolicy, override: Partial<CreatePolicyOptions>): SandboxPolicy {
  const mergedLimits: ExecutionLimits = {
    maxDurationMs: override.limits?.maxDurationMs ?? base.limits.maxDurationMs,
    maxCpuMs: override.limits?.maxCpuMs ?? base.limits.maxCpuMs,
    maxMemoryMb: override.limits?.maxMemoryMb ?? base.limits.maxMemoryMb,
    maxOutputBytes: override.limits?.maxOutputBytes ?? base.limits.maxOutputBytes,
    maxFileSize: override.limits?.maxFileSize ?? base.limits.maxFileSize,
  };

  return {
    id: base.id,
    name: override.name ?? base.name,
    limits: mergedLimits,
    allowedModules: override.allowedModules ?? base.allowedModules,
    deniedModules: override.deniedModules ?? base.deniedModules,
    networkAccess: override.networkAccess ?? base.networkAccess,
    fileSystemAccess: override.fileSystemAccess ?? base.fileSystemAccess,
    enabled: override.enabled ?? base.enabled,
  };
}
