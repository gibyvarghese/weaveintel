/**
 * @weaveintel/ui-primitives — Progress update builder
 */

import { randomUUID } from 'node:crypto';
import type { ProgressUpdate } from '@weaveintel/core';

export interface CreateProgressOptions {
  label: string;
  total: number;
  current?: number;
  details?: string;
}

/**
 * Create a ProgressUpdate with auto-calculated percentage.
 */
export function createProgress(opts: CreateProgressOptions): ProgressUpdate {
  const current = opts.current ?? 0;
  const percentage = opts.total > 0 ? Math.round((current / opts.total) * 100) : 0;
  return {
    taskId: randomUUID(),
    label: opts.label,
    current,
    total: opts.total,
    percentage,
    status: current >= opts.total ? 'completed' : 'running',
    details: opts.details,
  };
}

/**
 * Stateful progress tracker that increments and emits updates.
 */
export function createProgressTracker(label: string, total: number): ProgressTracker {
  const taskId = randomUUID();
  let current = 0;
  return {
    get taskId() { return taskId; },
    get current() { return current; },
    get total() { return total; },
    increment(n: number = 1, details?: string): ProgressUpdate {
      current = Math.min(current + n, total);
      const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
      return {
        taskId,
        label,
        current,
        total,
        percentage,
        status: current >= total ? 'completed' : 'running',
        details,
      };
    },
    complete(details?: string): ProgressUpdate {
      current = total;
      return { taskId, label, current, total, percentage: 100, status: 'completed', details };
    },
    fail(details?: string): ProgressUpdate {
      return {
        taskId,
        label,
        current,
        total,
        percentage: total > 0 ? Math.round((current / total) * 100) : 0,
        status: 'failed',
        details,
      };
    },
  };
}

export interface ProgressTracker {
  readonly taskId: string;
  readonly current: number;
  readonly total: number;
  increment(n?: number, details?: string): ProgressUpdate;
  complete(details?: string): ProgressUpdate;
  fail(details?: string): ProgressUpdate;
}
