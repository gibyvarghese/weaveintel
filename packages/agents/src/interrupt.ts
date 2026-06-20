/**
 * @weaveintel/agents — P3-1: Human-in-the-Loop (HITL) interrupt mechanism
 *
 * Provides types and a factory for suspending the agent loop at a tool call
 * to await a human approval / rejection / modification decision.
 *
 * The `onInterrupt` hook on `ToolCallingAgentOptions` accepts any function
 * matching `InterruptHandler`. `createHumanTaskInterruptHandler` wires the
 * hook to `@weaveintel/human-tasks` so geneWeave (or any other host) can
 * persist tasks to a DB and let a human click Approve in the UI before the
 * tool fires.
 *
 * Poll-based resolution: the handler enqueues an `ApprovalTask`, then polls
 * until it reaches a terminal state (completed / rejected / expired). This
 * keeps the host completely decoupled — any task store can back the queue.
 */

import type { ExecutionContext } from '@weaveintel/core';
import { weaveAudit } from '@weaveintel/core';
import type { HumanTaskQueue } from '@weaveintel/core';
import { createApprovalTask } from '@weaveintel/human-tasks';

// ─── Public types ─────────────────────────────────────────────

export type InterruptType = 'tool_approval' | 'policy_threshold' | 'explicit' | 'budget_warning';

export interface InterruptEvent {
  /** Why the interrupt was raised. */
  type: InterruptType;
  /** Name of the tool whose invocation triggered this interrupt. */
  toolName: string;
  /** Parsed tool arguments (as passed by the model). */
  toolArgs: Record<string, unknown>;
  /** Human-readable explanation of why approval is needed. */
  reason: string;
  /** Zero-based index of the current agent step. */
  agentStep: number;
  /** Agent name that raised the interrupt. */
  agentName: string;
}

export interface InterruptResolution {
  /** Whether to proceed with the tool call, abort it, or modify its arguments. */
  action: 'approve' | 'reject' | 'modify';
  /**
   * Replacement arguments for the tool call.  Only meaningful when
   * `action === 'modify'`.  Missing keys keep their original values.
   */
  modifiedArgs?: Record<string, unknown>;
  /**
   * Optional human feedback injected into the conversation as a user message
   * before the next model generation (visible to the LLM).
   */
  feedback?: string;
}

/**
 * Async function that suspends the agent until a human decides what to do.
 * May await an external signal (HTTP long-poll, WebSocket, DB query, etc.).
 */
export type InterruptHandler = (
  ctx: ExecutionContext,
  event: InterruptEvent,
) => Promise<InterruptResolution>;

// ─── Human-task backed handler factory ───────────────────────

export interface HumanTaskInterruptHandlerOptions {
  /**
   * Milliseconds between polls when waiting for the human decision.
   * Default: 2 000 ms.
   */
  pollIntervalMs?: number;
  /**
   * Maximum total wait time before the interrupt expires as 'rejected'.
   * Default: 300 000 ms (5 minutes).
   */
  timeoutMs?: number;
  /**
   * Assignee identifier (e.g. 'admin', email, role) attached to the task.
   * When omitted the task is unassigned.
   */
  assignee?: string;
  /**
   * SLA deadline in ISO 8601 format.  If the task is not resolved before this
   * time, the queue will mark it expired and this handler will reject.
   */
  slaDeadline?: string;
}

/**
 * Creates an `InterruptHandler` backed by a `HumanTaskQueue`.
 *
 * 1. Creates an approval task in the queue with full interrupt context.
 * 2. Polls `queue.get(taskId)` at `pollIntervalMs` until the task reaches a
 *    terminal state.
 * 3. Maps the terminal state to an `InterruptResolution`:
 *    - `completed` → inspect `task.result.decision`:
 *        - `'approve'`          → `{ action: 'approve' }`
 *        - `'modify'`           → `{ action: 'modify', modifiedArgs, feedback }`
 *        - anything else        → `{ action: 'reject' }`
 *    - `rejected` | `expired`  → `{ action: 'reject' }`
 *
 * Usage:
 * ```ts
 * const queue = new InMemoryTaskQueue();
 * const handler = createHumanTaskInterruptHandler(queue, { assignee: 'admin@acme.com' });
 * const agent = weaveAgent({ ..., onInterrupt: handler });
 * ```
 */
export function createHumanTaskInterruptHandler(
  queue: HumanTaskQueue,
  opts: HumanTaskInterruptHandlerOptions = {},
): InterruptHandler {
  const pollIntervalMs = opts.pollIntervalMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 300_000;

  return async (ctx: ExecutionContext, event: InterruptEvent): Promise<InterruptResolution> => {
    const task = createApprovalTask({
      title: `Agent tool approval: ${event.toolName}`,
      description: `Agent "${event.agentName}" wants to call tool "${event.toolName}".\nReason: ${event.reason}`,
      action: event.toolName,
      context: {
        toolArgs: event.toolArgs,
        agentName: event.agentName,
        agentStep: event.agentStep,
        interruptType: event.type,
      },
      riskLevel: event.type === 'policy_threshold' ? 'high' : 'medium',
      priority: event.type === 'policy_threshold' ? 'urgent' : 'normal',
      assignee: opts.assignee,
      slaDeadline: opts.slaDeadline,
    });

    const enqueued = await queue.enqueue(task);
    const taskId = enqueued.id;

    void weaveAudit(ctx, {
      action: 'agent.interrupt.enqueued',
      outcome: 'success',
      resource: event.toolName,
      details: { taskId, agentName: event.agentName, reason: event.reason },
    });

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const current = await queue.get(taskId);
      if (!current) break;

      if (current.status === 'completed') {
        const data = current.result as Record<string, unknown> | undefined;
        const decision = (data?.['decision'] as string | undefined) ?? 'reject';

        void weaveAudit(ctx, {
          action: 'agent.interrupt.resolved',
          outcome: 'success',
          resource: event.toolName,
          details: { taskId, decision },
        });

        if (decision === 'approve') {
          return { action: 'approve', feedback: data?.['feedback'] as string | undefined };
        }
        if (decision === 'modify') {
          return {
            action: 'modify',
            modifiedArgs: (data?.['modifiedArgs'] as Record<string, unknown> | undefined) ?? {},
            feedback: data?.['feedback'] as string | undefined,
          };
        }
        return {
          action: 'reject',
          feedback: data?.['feedback'] as string | undefined ?? `Rejected by human reviewer (task ${taskId})`,
        };
      }

      if (current.status === 'rejected' || current.status === 'expired') {
        void weaveAudit(ctx, {
          action: 'agent.interrupt.resolved',
          outcome: 'failure',
          resource: event.toolName,
          details: { taskId, status: current.status },
        });
        return {
          action: 'reject',
          feedback: `Tool call rejected: task ${taskId} ended with status "${current.status}"`,
        };
      }

      // Still pending — wait and retry
      await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
    }

    // Timed out
    void weaveAudit(ctx, {
      action: 'agent.interrupt.timeout',
      outcome: 'failure',
      resource: event.toolName,
      details: { taskId, timeoutMs },
    });
    return {
      action: 'reject',
      feedback: `Tool call approval timed out after ${timeoutMs}ms (task ${taskId})`,
    };
  };
}

// ─── Synchronous auto-approve handler (for testing / dev) ────

/**
 * An `InterruptHandler` that immediately approves every tool call.
 * Useful for testing the interrupt wiring without a real queue.
 */
export const autoApproveInterruptHandler: InterruptHandler = async (_ctx, _event) => ({
  action: 'approve',
});

/**
 * An `InterruptHandler` that immediately rejects every tool call.
 * Useful for testing the reject path.
 */
export const autoRejectInterruptHandler: InterruptHandler = async (_ctx, event) => ({
  action: 'reject',
  feedback: `Auto-rejected tool "${event.toolName}" by policy`,
});
