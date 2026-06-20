/**
 * Phase 4 — In-process run cancellation bus.
 *
 * Provides fast in-process cancellation on top of the existing DB-polled
 * `stop_requested` flag. Callers that hold an AbortSignal from this bus can
 * react to cancellation immediately without waiting for the next DB poll.
 *
 * Usage:
 *   const bus = new RunCancellationBus();
 *   bus.cancel(runId);                   // fire abort signal
 *   const sig = bus.getSignal(runId);    // AbortSignal | undefined
 *   bus.isCancelled(runId);              // boolean
 *   bus.clear(runId);                    // remove (GC after run ends)
 */

export class RunCancellationBus {
  private readonly controllers = new Map<string, AbortController>();

  /**
   * Cancel the run. Fires the AbortController for `runId`. Idempotent —
   * calling cancel on an already-cancelled run is a no-op.
   */
  cancel(runId: string): void {
    let ctrl = this.controllers.get(runId);
    if (!ctrl) {
      ctrl = new AbortController();
      this.controllers.set(runId, ctrl);
    }
    if (!ctrl.signal.aborted) {
      ctrl.abort();
    }
  }

  /**
   * Returns the AbortSignal for `runId`, or `undefined` if no cancellation
   * has been requested for this run.
   */
  getSignal(runId: string): AbortSignal | undefined {
    return this.controllers.get(runId)?.signal;
  }

  /** Returns true when `cancel(runId)` has been called. */
  isCancelled(runId: string): boolean {
    return this.controllers.get(runId)?.signal.aborted ?? false;
  }

  /**
   * Remove the entry for `runId`. Call after the run is fully stopped to
   * prevent unbounded memory growth.
   */
  clear(runId: string): void {
    this.controllers.delete(runId);
  }

  /** Number of tracked runs (pending + cancelled). For diagnostics. */
  get size(): number {
    return this.controllers.size;
  }
}
