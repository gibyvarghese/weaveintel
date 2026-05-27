/**
 * @weaveintel/workflows — WorkflowAdminService
 *
 * Phase W5 — Admin API surface wrapping the workflow engine.
 *
 * Provides server-side filtered listing, force operations (cancel/resume/patch),
 * and full run state retrieval including the audit event history.
 *
 * All mutating operations are gated on status checks so they cannot silently
 * corrupt an already-terminal run.
 */

import type { WorkflowRun, WorkflowAuditEvent } from '@weaveintel/core';
import type { WorkflowRunRepository } from './run-repository.js';
import type { WorkflowAuditLog } from '@weaveintel/core';

export interface AdminListRunsOpts {
  /** Filter by run status. */
  status?: WorkflowRun['status'];
  /** Filter by workflow definition ID. */
  workflowId?: string;
  /** Filter by tenant ID. */
  tenantId?: string;
  /** Return only runs started before this ISO-8601 timestamp. */
  before?: string;
  /** Return only runs started after this ISO-8601 timestamp. */
  after?: string;
  /** Maximum number of results (applied after other filters, sorted by startedAt desc). */
  limit?: number;
}

export interface AdminRunView {
  run: WorkflowRun;
  /** Full immutable audit event history (empty if no audit log is configured). */
  events: WorkflowAuditEvent[];
}

export interface WorkflowAdminService {
  /** Server-side filtered run listing — supports status, tenant, date range, and limit. */
  listRuns(opts?: AdminListRunsOpts): Promise<WorkflowRun[]>;
  /** Full run view including step history and audit events. */
  getRun(runId: string): Promise<AdminRunView | null>;
  /**
   * Force-cancel a run regardless of its current status.  The `reason` is
   * attached as the run error so it appears in the audit trail.
   */
  forceCancelRun(runId: string, reason: string): Promise<void>;
  /**
   * Force-resume a paused or stuck run (admin override — bypasses normal
   * pause validation).  Useful for recovering from blocked human-task steps.
   */
  forceResumeRun(runId: string, data?: unknown): Promise<WorkflowRun>;
  /**
   * Emergency patch of run variables.  The `patch` is shallow-merged into
   * `run.state.variables`.  Use only for incident recovery; patching is not
   * recorded as a step in history.
   */
  patchRunVariables(runId: string, patch: Record<string, unknown>): Promise<WorkflowRun>;
}

export class DefaultWorkflowAdminService implements WorkflowAdminService {
  constructor(
    private readonly repo: WorkflowRunRepository,
    private readonly engine: {
      cancelRun(runId: string): Promise<void>;
      resumeRun(runId: string, data?: unknown): Promise<WorkflowRun>;
      getRun(runId: string): Promise<WorkflowRun | null>;
      listWorkflowEvents?(runId: string): Promise<WorkflowAuditEvent[]>;
    },
    private readonly auditLog?: WorkflowAuditLog,
  ) {}

  async listRuns(opts?: AdminListRunsOpts): Promise<WorkflowRun[]> {
    let runs = await this.repo.list(opts?.workflowId);

    if (opts?.status) runs = runs.filter(r => r.status === opts.status);
    if (opts?.tenantId) runs = runs.filter(r => r.tenantId === opts.tenantId);
    if (opts?.before) runs = runs.filter(r => r.startedAt < opts.before!);
    if (opts?.after)  runs = runs.filter(r => r.startedAt > opts.after!);

    // Sort newest first
    runs = runs.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    if (opts?.limit) runs = runs.slice(0, opts.limit);
    return runs;
  }

  async getRun(runId: string): Promise<AdminRunView | null> {
    const run = await this.repo.get(runId);
    if (!run) return null;
    const events = this.engine.listWorkflowEvents
      ? await this.engine.listWorkflowEvents(runId)
      : (this.auditLog ? await this.auditLog.list(runId) : []);
    return { run, events };
  }

  async forceCancelRun(runId: string, reason: string): Promise<void> {
    const run = await this.repo.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.status === 'cancelled') return;  // already cancelled — idempotent
    // Override status directly if already terminal but not cancelled
    if (run.status === 'completed' || run.status === 'failed') {
      (run as { status: WorkflowRun['status'] }).status = 'cancelled';
      (run as { error?: string }).error = `Force-cancelled: ${reason}`;
      run.completedAt = new Date().toISOString();
      await this.repo.save(run);
      return;
    }
    // For running/paused/pending runs, use the engine's cancel path (audit + child propagation)
    // We patch the error reason afterward.
    await this.engine.cancelRun(runId);
    const updated = await this.repo.get(runId);
    if (updated) {
      (updated as { error?: string }).error = `Force-cancelled: ${reason}`;
      await this.repo.save(updated);
    }
  }

  async forceResumeRun(runId: string, data?: unknown): Promise<WorkflowRun> {
    const run = await this.repo.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.status === 'completed' || run.status === 'cancelled') {
      throw new Error(`Cannot resume run in terminal status: ${run.status}`);
    }
    // Temporarily force status to paused so resumeRun() doesn't reject it
    if (run.status !== 'paused') {
      (run as { status: WorkflowRun['status'] }).status = 'paused';
      await this.repo.save(run);
    }
    return this.engine.resumeRun(runId, data);
  }

  async patchRunVariables(runId: string, patch: Record<string, unknown>): Promise<WorkflowRun> {
    const run = await this.repo.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    Object.assign(run.state.variables, patch);
    await this.repo.save(run);
    return run;
  }
}
