/**
 * Generic, domain-agnostic trace-retrieval tools for live agents.
 *
 * --- HARD SCOPING INVARIANT ---
 * Every tool in the returned registry closes over a SINGLE `runId`
 * resolved at prepare-time from the agent's mesh / current run. The LLM
 * cannot pass `runId` as an argument; even if a future caller adds one
 * the value is ignored. Single-row fetchers (`live_get_event_details`,
 * `live_get_step_artifact`) re-validate `row.run_id === closure runId`
 * and refuse cross-run lookups with a structured error so a confused or
 * adversarial model can never disclose another run's payload.
 *
 * This is the lazy-trace-retrieval lever (L5b in
 * `docs/COST_CONTROL_PLAN.md`) generalised from the kaggle prototype:
 * cuts long-run prompt size by giving agents a way to fetch back-history
 * on demand instead of carrying full ReAct messages every tick.
 */

import {
  weaveToolRegistry as createToolRegistry,
  weaveTool as defineTool,
  type ToolRegistry,
} from '@weaveintel/core';
import type {
  CostSoFarReader,
  LiveRunEventLike,
  LiveRunEventReader,
  LiveRunStepLike,
  LiveRunStepReader,
} from './reader.js';

export interface CreateLiveTraceToolsOptions {
  /** The ONLY run id these tools may read from. Resolved upstream from
   *  the agent's mesh id at prepare time. */
  runId: string;
  /** Required event reader. */
  eventReader: LiveRunEventReader;
  /** Optional step reader. When omitted, the timeline tool falls back to
   *  reconstructing pseudo-steps from event kinds. */
  stepReader?: LiveRunStepReader;
  /** Optional running-cost reader. When supplied, the timeline tool emits
   *  a `costUsdSoFar` field so the model can self-pace against budget. */
  costReader?: CostSoFarReader;
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Hard cap on rows returned by any single tool call. Default 25, max 100.
   *  Prevents the LLM from blowing prompt budget by asking for "everything". */
  maxRowsPerCall?: number;
  /** Tag prefix applied to every emitted tool's `tags`. Default 'live'.
   *  Domains may override (e.g. 'kaggle', 'sv') so registries stay grep-able. */
  tagPrefix?: string;
}

/** Compact projection of an event row. */
function projectEvent(row: LiveRunEventLike, includePayload = false): Record<string, unknown> {
  return {
    id: row.id,
    stepId: row.step_id,
    kind: row.kind,
    agentId: row.agent_id,
    toolKey: row.tool_key,
    summary: row.summary,
    createdAt: row.created_at,
    ...(includePayload && row.payload_json ? { payload: safeParse(row.payload_json) } : {}),
  };
}

/** Compact projection of a step row. */
function projectStep(row: LiveRunStepLike, maxPreviewBytes = 600): Record<string, unknown> {
  return {
    id: row.id,
    agentId: row.agent_id,
    role: row.role_key,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    summary: row.summary,
    payloadPreview: truncatePayload(row.payload_json, maxPreviewBytes),
  };
}

function truncatePayload(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  if (s.length <= max) return s;
  return s.slice(0, max) + `…[+${s.length - max}b]`;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return { _raw: json.slice(0, 200) };
  }
}

/** Heuristic: which event kinds count as "failure-class" for the
 *  failed-attempts tool. Domain code may emit additional kinds; we keep
 *  the default set conservative and well-known. */
const FAILURE_EVENT_KINDS = new Set<string>([
  'tick.errored',
  'policy.decision', // includes deny/approval-blocked when summary indicates so
  'tool.errored',
  'error',
]);

function isFailureEvent(e: LiveRunEventLike): boolean {
  if (FAILURE_EVENT_KINDS.has(e.kind)) {
    if (e.kind === 'policy.decision') {
      // Only count denied / blocked decisions, not 'allowed' ones.
      const s = (e.summary ?? '').toLowerCase();
      return s.includes('deny') || s.includes('block') || s.includes('refus');
    }
    return true;
  }
  return false;
}

export function createLiveTraceTools(opts: CreateLiveTraceToolsOptions): ToolRegistry {
  const { runId, eventReader } = opts;
  const stepReader = opts.stepReader;
  const costReader = opts.costReader;
  const log = opts.log ?? (() => {});
  const maxRows = Math.max(1, Math.min(opts.maxRowsPerCall ?? 25, 100));
  const tagPrefix = opts.tagPrefix ?? 'live';

  if (!runId) {
    throw new Error('createLiveTraceTools: runId is required (must be the agent current run)');
  }

  const tags: readonly string[] = [tagPrefix, 'trace', 'read'];
  const reg = createToolRegistry();

  // ── 1. live_get_run_timeline ────────────────────────────────
  reg.register(
    defineTool({
      name: 'live_get_run_timeline',
      description:
        'Return a compact timeline of step / phase progress for THE CURRENT run only. Use this to recall what phases have already completed and what their summaries said, instead of carrying full prior turns in your prompt. When a budget gate is wired, the response also includes `costUsdSoFar` so you can self-pace.',
      parameters: {
        type: 'object',
        properties: {
          statusFilter: {
            type: 'string',
            description:
              'Optional. Only return steps matching this status (e.g. PENDING|RUNNING|COMPLETED|FAILED). Case-insensitive.',
          },
          lastN: {
            type: 'number',
            description: `How many most-recent steps to return. Default 10, max ${maxRows}.`,
          },
        },
      },
      tags: [...tags],
      riskLevel: 'read-only',
      execute: async (args) => {
        const lastN = Math.max(1, Math.min(Number(args['lastN'] ?? 10), maxRows));
        const statusFilterRaw = args['statusFilter'];
        const statusFilter =
          typeof statusFilterRaw === 'string' && statusFilterRaw.trim()
            ? statusFilterRaw.trim().toUpperCase()
            : null;

        let totalSteps = 0;
        let stepsView: Record<string, unknown>[] = [];
        if (stepReader) {
          const allSteps = await stepReader.listSteps({ runId });
          totalSteps = allSteps.length;
          const filtered = statusFilter
            ? allSteps.filter((s) => s.status.toUpperCase() === statusFilter)
            : allSteps;
          stepsView = filtered.slice(-lastN).map((s) => projectStep(s));
        } else {
          // Degraded mode: derive pseudo-steps from event kinds.
          const events = await eventReader.listEvents({ runId, limit: maxRows * 4 });
          const stepEvents = events.filter(
            (e) => e.kind === 'tick.started' || e.kind === 'tick.completed' || e.kind === 'tick.errored',
          );
          totalSteps = stepEvents.length;
          stepsView = stepEvents.slice(-lastN).map((e) => projectEvent(e, false));
        }

        let costUsdSoFar: number | null = null;
        if (costReader) {
          try {
            costUsdSoFar = await costReader(runId);
          } catch (err) {
            log(`live_get_run_timeline: costReader threw — ignoring (${(err as Error).message})`);
          }
        }

        log(`live_get_run_timeline: runId=${runId} returned ${stepsView.length}/${totalSteps} steps`);
        return JSON.stringify(
          {
            runId,
            totalSteps,
            returned: stepsView.length,
            steps: stepsView,
            ...(costUsdSoFar !== null ? { costUsdSoFar } : {}),
          },
          null,
          2,
        );
      },
    }),
  );

  // ── 2. live_get_failed_attempts ────────────────────────────
  reg.register(
    defineTool({
      name: 'live_get_failed_attempts',
      description:
        'Return only the FAILED steps + error events for THE CURRENT run. Use this when planning a retry to recall what already failed and avoid repeating it. Cheaper than re-reading full ReAct history.',
      parameters: {
        type: 'object',
        properties: {
          lastN: {
            type: 'number',
            description: `Max number of failed records to return. Default 10, max ${maxRows}.`,
          },
        },
      },
      tags: [...tags],
      riskLevel: 'read-only',
      execute: async (args) => {
        const lastN = Math.max(1, Math.min(Number(args['lastN'] ?? 10), maxRows));
        const events = await eventReader.listEvents({ runId, limit: 500 });
        const failedEvents = events.filter(isFailureEvent);

        let failedSteps: LiveRunStepLike[] = [];
        if (stepReader) {
          const allSteps = await stepReader.listSteps({ runId });
          failedSteps = allSteps.filter((s) => s.status.toUpperCase() === 'FAILED');
        }

        const records = [
          ...failedSteps.slice(-lastN).map((s) => ({ kind: 'step', record: projectStep(s) })),
          ...failedEvents.slice(-lastN).map((e) => ({ kind: 'event', record: projectEvent(e, false) })),
        ];

        log(
          `live_get_failed_attempts: runId=${runId} returned ${records.length} ` +
            `(steps=${failedSteps.length} events=${failedEvents.length})`,
        );

        return JSON.stringify(
          {
            runId,
            failedStepsCount: failedSteps.length,
            failedEventsCount: failedEvents.length,
            failures: records.slice(0, lastN),
          },
          null,
          2,
        );
      },
    }),
  );

  // ── 3. live_get_recent_events ──────────────────────────────
  reg.register(
    defineTool({
      name: 'live_get_recent_events',
      description:
        'Stream recent events from THE CURRENT run only. Optional `kind` filter (e.g. "tool.resolved", "model.resolved", "contract.changed", "tick.completed"). Use when you need to know what JUST happened in the last few ticks without carrying full message history.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            description:
              'Optional event-kind filter. Common values: tool.resolved, model.resolved, policy.decision, contract.changed, tick.started, tick.completed, tick.errored.',
          },
          afterId: {
            type: 'string',
            description:
              'Optional UUID. Returns events strictly newer than this one (paginate forward).',
          },
          limit: {
            type: 'number',
            description: `Max events to return. Default 20, max ${maxRows}.`,
          },
        },
      },
      tags: [...tags],
      riskLevel: 'read-only',
      execute: async (args) => {
        const limit = Math.max(1, Math.min(Number(args['limit'] ?? 20), maxRows));
        const kindRaw = args['kind'];
        const kind = typeof kindRaw === 'string' && kindRaw.trim() ? kindRaw.trim() : undefined;
        const afterIdRaw = args['afterId'];
        const afterId =
          typeof afterIdRaw === 'string' && afterIdRaw.trim() ? afterIdRaw.trim() : undefined;

        const events = await eventReader.listEvents({
          runId,
          ...(afterId ? { afterId } : {}),
          // When kind-filtering we over-fetch then narrow client-side so
          // pagination semantics stay simple for the LLM.
          limit: kind ? Math.min(maxRows * 4, 200) : limit,
        });
        const filtered = kind ? events.filter((e) => e.kind === kind) : events;
        const sliced = filtered.slice(-limit);

        log(
          `live_get_recent_events: runId=${runId} kind=${kind ?? '*'} returned ${sliced.length}/${events.length}`,
        );
        return JSON.stringify(
          {
            runId,
            returned: sliced.length,
            events: sliced.map((e) => projectEvent(e, false)),
          },
          null,
          2,
        );
      },
    }),
  );

  // ── 4. live_get_event_details ──────────────────────────────
  reg.register(
    defineTool({
      name: 'live_get_event_details',
      description:
        'Fetch the full payload JSON for one event (by id) belonging to THE CURRENT run. Use after `live_get_recent_events` or `live_get_failed_attempts` flagged an event you need to inspect. Refuses event ids that do not belong to the current run.',
      parameters: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'UUID of the event to expand.' },
        },
        required: ['eventId'],
      },
      tags: [...tags],
      riskLevel: 'read-only',
      execute: async (args) => {
        const eventId = String(args['eventId'] ?? '').trim();
        if (!eventId) {
          return JSON.stringify({ error: 'eventId is required' });
        }
        const found = await eventReader.getEvent(eventId);
        // Re-validate run isolation at the row level — the reader may be
        // permissive but the tool is not.
        if (!found || found.run_id !== runId) {
          log(`live_get_event_details: event ${eventId} not in run ${runId} — refusing`);
          return JSON.stringify({
            error: 'event_not_in_current_run',
            message:
              'Refusing to disclose: this event id does not belong to the current run, or has been pruned.',
            runId,
          });
        }
        return JSON.stringify(projectEvent(found, true), null, 2);
      },
    }),
  );

  // ── 5. live_get_step_artifact ──────────────────────────────
  reg.register(
    defineTool({
      name: 'live_get_step_artifact',
      description:
        'Fetch the full payload preview for one step (by id) of THE CURRENT run — useful when `live_get_run_timeline` shows a step you want to read in full. Refuses step ids that do not belong to the current run, or returns an error when no step reader is wired.',
      parameters: {
        type: 'object',
        properties: {
          stepId: { type: 'string', description: 'UUID of the step to expand.' },
        },
        required: ['stepId'],
      },
      tags: [...tags],
      riskLevel: 'read-only',
      execute: async (args) => {
        const stepId = String(args['stepId'] ?? '').trim();
        if (!stepId) {
          return JSON.stringify({ error: 'stepId is required' });
        }
        if (!stepReader) {
          return JSON.stringify({
            error: 'step_reader_unavailable',
            message:
              'No step reader is wired into this trace-tools registry. Step artifact lookup is unsupported.',
            runId,
          });
        }
        const found = await stepReader.getStep(stepId);
        if (!found || found.run_id !== runId) {
          log(`live_get_step_artifact: step ${stepId} not in run ${runId} — refusing`);
          return JSON.stringify({
            error: 'step_not_in_current_run',
            message:
              'Refusing to disclose: this step id does not belong to the current run.',
            runId,
          });
        }
        return JSON.stringify(
          { runId, ...projectStep(found, /*maxPreviewBytes=*/ 4000) },
          null,
          2,
        );
      },
    }),
  );

  return reg;
}
