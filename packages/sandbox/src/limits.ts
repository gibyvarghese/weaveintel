/**
 * @weaveintel/sandbox — Execution limits
 */

import type { ExecutionLimits } from '@weaveintel/core';

export function createDefaultLimits(): Required<ExecutionLimits> {
  return {
    maxDurationMs: 30_000,
    maxCpuMs: 100_000,
    maxMemoryMb: 256,
    maxOutputBytes: 1_048_576,
    maxFileSize: 10_485_760,
  };
}

export function scaleLimits(limits: ExecutionLimits, factor: number): ExecutionLimits {
  if (factor <= 0) throw new Error('Scale factor must be positive');

  return {
    maxDurationMs: Math.round(limits.maxDurationMs * factor),
    maxCpuMs: limits.maxCpuMs !== undefined ? Math.round(limits.maxCpuMs * factor) : undefined,
    maxMemoryMb: limits.maxMemoryMb !== undefined ? Math.round(limits.maxMemoryMb * factor) : undefined,
    maxOutputBytes: limits.maxOutputBytes !== undefined ? Math.round(limits.maxOutputBytes * factor) : undefined,
    maxFileSize: limits.maxFileSize !== undefined ? Math.round(limits.maxFileSize * factor) : undefined,
  };
}

export interface LimitsEnforcement {
  exceeded: boolean;
  violations: string[];
}

export function enforceLimits(
  limits: ExecutionLimits,
  usage: { cpuMs: number; memoryMb: number; durationMs: number },
): LimitsEnforcement {
  const violations: string[] = [];

  if (usage.durationMs > limits.maxDurationMs) {
    violations.push(`Duration ${usage.durationMs}ms exceeds limit ${limits.maxDurationMs}ms`);
  }
  if (limits.maxCpuMs !== undefined && usage.cpuMs > limits.maxCpuMs) {
    violations.push(`CPU ${usage.cpuMs}ms exceeds limit ${limits.maxCpuMs}ms`);
  }
  if (limits.maxMemoryMb !== undefined && usage.memoryMb > limits.maxMemoryMb) {
    violations.push(`Memory ${usage.memoryMb}MB exceeds limit ${limits.maxMemoryMb}MB`);
  }

  return { exceeded: violations.length > 0, violations };
}
