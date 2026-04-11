/**
 * @weaveintel/sandbox — Result processing
 */

import type { SandboxResult } from '@weaveintel/core';

export function createSuccessResult(
  executionId: string,
  output: unknown,
  usage: { cpuMs: number; memoryMb: number; durationMs: number },
): SandboxResult {
  return {
    executionId,
    status: 'success',
    output,
    artifacts: [],
    resourceUsage: { ...usage },
  };
}

export function createErrorResult(
  executionId: string,
  error: string,
  usage: { cpuMs: number; memoryMb: number; durationMs: number },
): SandboxResult {
  return {
    executionId,
    status: 'error',
    error,
    artifacts: [],
    resourceUsage: { ...usage },
  };
}

export function isSuccessful(result: SandboxResult): result is SandboxResult & { status: 'success' } {
  return result.status === 'success';
}

export interface AggregateStats {
  total: number;
  succeeded: number;
  failed: number;
  avgCpuMs: number;
  avgMemoryMb: number;
  avgDurationMs: number;
  totalCpuMs: number;
  totalDurationMs: number;
  peakMemoryMb: number;
}

export function aggregateResults(results: readonly SandboxResult[]): AggregateStats {
  if (results.length === 0) {
    return {
      total: 0,
      succeeded: 0,
      failed: 0,
      avgCpuMs: 0,
      avgMemoryMb: 0,
      avgDurationMs: 0,
      totalCpuMs: 0,
      totalDurationMs: 0,
      peakMemoryMb: 0,
    };
  }

  let totalCpuMs = 0;
  let totalMemoryMb = 0;
  let totalDurationMs = 0;
  let peakMemoryMb = 0;
  let succeeded = 0;

  for (const r of results) {
    totalCpuMs += r.resourceUsage.cpuMs;
    totalMemoryMb += r.resourceUsage.memoryMb;
    totalDurationMs += r.resourceUsage.durationMs;
    if (r.resourceUsage.memoryMb > peakMemoryMb) peakMemoryMb = r.resourceUsage.memoryMb;
    if (r.status === 'success') succeeded++;
  }

  const count = results.length;

  return {
    total: count,
    succeeded,
    failed: count - succeeded,
    avgCpuMs: Math.round(totalCpuMs / count),
    avgMemoryMb: Math.round((totalMemoryMb / count) * 100) / 100,
    avgDurationMs: Math.round(totalDurationMs / count),
    totalCpuMs,
    totalDurationMs,
    peakMemoryMb,
  };
}
