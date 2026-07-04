/**
 * @weaveintel/core — Run handle contracts
 *
 * The client-facing view of any long-running execution: agent run, supervisor
 * run, workflow, scheduled job, or any other asynchronous operation that emits
 * a stream of events and has a lifecycle.
 *
 * Vocabulary rule: this module uses *runs, events, principals, status* —
 * never "chat", "conversation", "message", or "turn".
 */

// ─── Run status ───────────────────────────────────────────────────────────────

/**
 * Lifecycle status of a run.  Terminal states: `completed`, `failed`,
 * `cancelled`.  Promoted from `@weaveintel/collab` so all packages can
 * reference it without a collaboration dependency.
 */
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// ─── Run origin ───────────────────────────────────────────────────────────────

/**
 * How the run was initiated.
 * - `interactive`  — a principal (human or agent) started it directly.
 * - `trigger`      — a cron, webhook, or event trigger fired.
 * - `workflow`     — a parent workflow spawned it as a step.
 * - `system`       — internal scheduling or supervision logic.
 */
export type RunOrigin = 'interactive' | 'trigger' | 'workflow' | 'system';

// ─── Run handle ───────────────────────────────────────────────────────────────

/**
 * Immutable client-facing snapshot of a run at a point in time.
 *
 * Producers emit lifecycle events (`run.started`, `run.progress`, etc.) to
 * update this; consumers observe via `@weaveintel/client` or the SSE endpoint.
 */
export interface RunHandle {
  /** Unique identifier — UUID v7. */
  readonly runId: string;
  /** Tenant that owns this run. */
  readonly tenantId: string;
  /**
   * Principal (user or service identity) that owns the run.
   * Matches the identity vocabulary from `@weaveintel/identity`.
   */
  readonly principalId: string;
  /** How the run was initiated. */
  readonly origin: RunOrigin;
  /** Current lifecycle status. */
  readonly status: RunStatus;
  /**
   * Optional completion progress, 0..1.
   * Producers should set this when they have a meaningful estimate; clients
   * treat `undefined` as "unknown progress".
   */
  readonly progress?: number;
  /** Human-readable label, supplied by the producer (e.g. the user's prompt summary). */
  readonly label?: string;
  /** ISO-8601 timestamp when the run was registered. */
  readonly createdAt: string;
  /** ISO-8601 timestamp of the most recent status or progress change. */
  readonly updatedAt: string;
  /** ISO-8601 timestamp when the run reached a terminal state. */
  readonly completedAt?: string;
  /**
   * Highest `StreamEnvelope.sequence` number emitted so far.
   * Clients use this as a resume cursor: re-attach with `afterSequence` set to
   * this value to receive only new events.
   */
  readonly lastSequence: number;
  /**
   * Set when `status === 'failed'`.
   * `code` is a machine-readable error tag; `message` is human-readable.
   */
  readonly error?: { code: string; message: string };
  /**
   * Arbitrary producer-supplied metadata.
   * Clients treat this as opaque; do not rely on specific keys in framework code.
   */
  readonly metadata?: Record<string, unknown>;
}

// ─── Event cursor ─────────────────────────────────────────────────────────────

/**
 * Resume position for reading a run's event journal.
 *
 * Clients store the last-seen `sequence` number locally and pass it to
 * `GET /api/me/runs/:id/events?after=<afterSequence>` or to
 * `runClient.attach(runId, { afterSequence })` to resume without gaps.
 */
export interface RunEventCursor {
  readonly runId: string;
  /**
   * Read events with `sequence > afterSequence`.
   * Pass `0` to receive all events from the beginning.
   */
  readonly afterSequence: number;
}
