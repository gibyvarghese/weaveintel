/**
 * @weaveintel/human-tasks — Decision recording with audit trail
 */

import type { HumanDecision, HumanTask } from '@weaveintel/core';

export interface DecisionRecord extends HumanDecision {
  taskType: string;
  taskTitle: string;
}

export class DecisionLog {
  private readonly records: DecisionRecord[] = [];

  record(task: HumanTask, decision: HumanDecision): DecisionRecord {
    const rec: DecisionRecord = {
      ...decision,
      taskType: task.type,
      taskTitle: task.title,
    };
    this.records.push(rec);
    return rec;
  }

  getByTask(taskId: string): DecisionRecord[] {
    return this.records.filter(r => r.taskId === taskId);
  }

  getByDecider(decidedBy: string): DecisionRecord[] {
    return this.records.filter(r => r.decidedBy === decidedBy);
  }

  getAll(): DecisionRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records.length = 0;
  }
}

/**
 * Create a HumanDecision object — convenience helper.
 */
export function createDecision(
  taskId: string,
  decidedBy: string,
  decision: string,
  opts?: { reason?: string; data?: unknown },
): HumanDecision {
  return {
    taskId,
    decidedBy,
    decision,
    reason: opts?.reason,
    data: opts?.data,
    decidedAt: new Date().toISOString(),
  };
}
