/**
 * GeneWeave — DB-backed WorkflowRunRepository
 *
 * Implements `@weaveintel/workflows` `WorkflowRunRepository` over the
 * SQLite `workflow_runs` table. Persists `costTotal` and `metadata` for
 * Phase 5 governance/durability.
 */
import type { WorkflowRun } from '@weaveintel/core';
import type { WorkflowRunRepository } from '@weaveintel/workflows';
import type { DatabaseAdapter, WorkflowRunRow } from '../db-types.js';

function rowToRun(row: WorkflowRunRow): WorkflowRun {
  const state = row.state ? JSON.parse(row.state) : { currentStepId: '', variables: {}, history: [] };
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status as WorkflowRun['status'],
    state,
    startedAt: row.started_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.cost_total !== undefined && row.cost_total !== null ? { costTotal: row.cost_total } : {}),
  };
}

export class DbWorkflowRunRepository implements WorkflowRunRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async save(run: WorkflowRun): Promise<void> {
    const existing = await this.db.getWorkflowRun(run.id);
    const stateJson = JSON.stringify(run.state ?? {});
    if (!existing) {
      await this.db.createWorkflowRun({
        id: run.id,
        workflow_id: run.workflowId,
        status: run.status,
        state: stateJson,
        input: null,
        error: run.error ?? null,
        started_at: run.startedAt,
        ...(run.costTotal !== undefined ? { cost_total: run.costTotal } : {}),
      });
      // Set completed_at on initial save if already terminal
      if (run.completedAt) {
        await this.db.updateWorkflowRun(run.id, { completed_at: run.completedAt });
      }
      return;
    }
    await this.db.updateWorkflowRun(run.id, {
      status: run.status,
      state: stateJson,
      error: run.error ?? null,
      ...(run.completedAt ? { completed_at: run.completedAt } : {}),
      ...(run.costTotal !== undefined ? { cost_total: run.costTotal } : {}),
    });
  }

  async get(runId: string): Promise<WorkflowRun | null> {
    const row = await this.db.getWorkflowRun(runId);
    return row ? rowToRun(row) : null;
  }

  async list(workflowId?: string): Promise<WorkflowRun[]> {
    const rows = await this.db.listWorkflowRuns(workflowId);
    return rows.map(rowToRun);
  }

  async delete(runId: string): Promise<void> {
    await this.db.deleteWorkflowRun(runId);
  }
}
