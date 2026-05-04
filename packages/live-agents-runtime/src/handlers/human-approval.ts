/**
 * Built-in handler kind: `human.approval`.
 *
 * Parks a tick by recording an approval request in `tool_approval_requests`
 * (the existing Tool Platform Phase 6 table) and waiting for an operator
 * to approve / deny it via the admin UI. Designed for "dual-control" gates
 * — e.g. the Kaggle submitter must wait for a human to OK
 * `kaggle.competitions.submit` before any actual call goes out.
 *
 * --- Config shape (`live_agent_handler_bindings.config_json`) ---
 *
 *   {
 *     "approvalKind":         "kaggle.submit",
 *     "dualControlActions":   ["kaggle.competitions.submit"],
 *     "policyKey":            "destructive_gate",      // optional
 *     "onApprovedSubject":    "Approved — proceed",     // optional
 *     "onApprovedTo":         { "type": "AGENT_BY_ROLE", "roleKey": "executor" } // optional
 *   }
 *
 * Behaviour per tick:
 *   1. Read the latest inbound TASK (must exist; otherwise no-op).
 *   2. If a `pending` approval exists for `(approvalKind, chatId=meshId)`, do nothing.
 *   3. If an `approved` row exists newer than the inbound message, optionally
 *      forward to `onApprovedTo` and mark the tick complete.
 *   4. Otherwise INSERT a fresh `pending` row tagged with skill_key=approvalKind,
 *      tool_name=first(dualControlActions), policy_key=policyKey, input_json=<inbound>.
 *
 * The handler **never executes the gated action itself** — it only records
 * the gate. The downstream "executor" agent / handler observes the approved
 * forward (when `onApprovedTo` is configured) or the admin operator
 * triggers the next step out-of-band.
 *
 * --- Required HandlerContext extras ---
 *
 *   ctx.approvalDb — minimal slice of DatabaseAdapter exposing the
 *   `tool_approval_requests` CRUD methods used here. Geneweave wires this
 *   in via `human.approval` registration at boot.
 */

import type {
  ActionExecutionContext,
  AttentionAction,
  Message,
  TaskHandler,
  TaskHandlerResult,
} from '@weaveintel/live-agents';
import { loadLatestInboundTask } from '@weaveintel/live-agents';
import type { ExecutionContext } from '@weaveintel/core';
import type { HandlerContext, HandlerKindRegistration } from '../handler-registry.js';
import type {
  DeterministicForwardTarget,
  DeterministicForwardContextExtras,
} from './deterministic-forward.js';

/** Minimal approval-request row shape (matches `ToolApprovalRequestRow`). */
export interface ApprovalRequestRowLike {
  id: string;
  tool_name: string;
  chat_id: string;
  user_id: string | null;
  input_json: string;
  policy_key: string | null;
  skill_key: string | null;
  status: string;        // 'pending' | 'approved' | 'denied' | 'expired'
  requested_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

/** DB slice the handler needs. Geneweave passes `db` directly. */
export interface ApprovalDb {
  createToolApprovalRequest(r: Omit<ApprovalRequestRowLike, 'requested_at'>): Promise<void>;
  getApprovedToolRequest(toolName: string, chatId: string): Promise<ApprovalRequestRowLike | null>;
  getPendingToolRequest(toolName: string, chatId: string): Promise<ApprovalRequestRowLike | null>;
}

/** ID generator (geneweave injects `newUUIDv7`). Defaults to `crypto.randomUUID`. */
export type ApprovalIdGenerator = () => string;

/** Optional extension to `HandlerContext` for `human.approval` only. */
export interface HumanApprovalContextExtras {
  approvalDb?: ApprovalDb;
  newApprovalId?: ApprovalIdGenerator;
}

export interface HumanApprovalConfig {
  approvalKind: string;
  dualControlActions: string[];
  policyKey?: string;
  onApprovedSubject?: string;
  onApprovedTo?: DeterministicForwardTarget;
}

function readConfig(raw: Record<string, unknown>): HumanApprovalConfig {
  if (typeof raw['approvalKind'] !== 'string' || raw['approvalKind'].length === 0) {
    throw new Error('human.approval: config.approvalKind required.');
  }
  const dca = raw['dualControlActions'];
  if (!Array.isArray(dca) || dca.length === 0 || !dca.every((x) => typeof x === 'string')) {
    throw new Error('human.approval: config.dualControlActions must be a non-empty string[].');
  }
  const cfg: HumanApprovalConfig = {
    approvalKind: raw['approvalKind'],
    dualControlActions: dca as string[],
  };
  if (typeof raw['policyKey'] === 'string') cfg.policyKey = raw['policyKey'];
  if (typeof raw['onApprovedSubject'] === 'string') cfg.onApprovedSubject = raw['onApprovedSubject'];
  if (raw['onApprovedTo'] && typeof raw['onApprovedTo'] === 'object') {
    cfg.onApprovedTo = raw['onApprovedTo'] as DeterministicForwardTarget;
  }
  return cfg;
}

function makeId(prefix: string, nowIso: string): string {
  return `${prefix}_${Date.parse(nowIso)}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildHumanApproval(
  ctx: HandlerContext & HumanApprovalContextExtras & DeterministicForwardContextExtras,
): TaskHandler {
  const cfg = readConfig(ctx.binding.config);
  if (!ctx.approvalDb) {
    throw new Error(
      `human.approval: binding ${ctx.binding.id} requires HandlerContext.approvalDb. ` +
        'Geneweave must wire DatabaseAdapter into the handler context.',
    );
  }
  const newId = ctx.newApprovalId ?? (() => crypto.randomUUID());
  const toolKey = cfg.dualControlActions[0]!;

  return async (
    _action: AttentionAction & { type: 'StartTask' | 'ContinueTask' },
    execCtx: ActionExecutionContext,
    _ctx: ExecutionContext,
  ): Promise<TaskHandlerResult> => {
    const inbound = await loadLatestInboundTask(execCtx);
    if (!inbound) {
      return { completed: true, summaryProse: 'no-op (empty inbox)' };
    }

    // Use mesh id as `chat_id` — every mesh is one logical conversation.
    const chatId = ctx.agent.meshId;

    // 1. If an approval was already granted, optionally forward and finish.
    const approved = await ctx.approvalDb!.getApprovedToolRequest(toolKey, chatId);
    if (approved) {
      if (cfg.onApprovedTo && cfg.onApprovedSubject) {
        let toType: Message['toType'];
        let toId: string | null;
        if (cfg.onApprovedTo.type === 'BROADCAST') { toType = 'BROADCAST'; toId = null; }
        else if (cfg.onApprovedTo.type === 'AGENT') { toType = 'AGENT'; toId = cfg.onApprovedTo.id; }
        else {
          if (!ctx.resolveAgentByRole) throw new Error('human.approval: AGENT_BY_ROLE without resolver.');
          const id = await Promise.resolve(ctx.resolveAgentByRole(cfg.onApprovedTo.roleKey));
          if (!id) throw new Error(`human.approval: no agent for role "${cfg.onApprovedTo.roleKey}".`);
          toType = 'AGENT'; toId = id;
        }
        const out: Message = {
          id: makeId('msg', execCtx.nowIso),
          meshId: ctx.agent.meshId,
          fromType: 'AGENT', fromId: ctx.agent.id, fromMeshId: ctx.agent.meshId,
          toType, toId,
          topic: null, kind: 'TASK',
          replyToMessageId: null, threadId: makeId('thr', execCtx.nowIso),
          contextRefs: [], contextPacketRef: null, expiresAt: null,
          priority: 'NORMAL', status: 'DELIVERED',
          deliveredAt: execCtx.nowIso, readAt: null, processedAt: null, createdAt: execCtx.nowIso,
          subject: cfg.onApprovedSubject,
          body: `Approval ${approved.id} granted for ${toolKey}. Original payload:\n\n${inbound.body}`,
        };
        await execCtx.stateStore.saveMessage(out);
        ctx.log(`human.approval: approval ${approved.id} consumed; forwarded to ${toType}${toId ? `:${toId}` : ''}.`);
        return { completed: true, summaryProse: `Approved & forwarded (${approved.id})`, createdMessageIds: [out.id] };
      }
      return { completed: true, summaryProse: `Approved out-of-band (${approved.id})` };
    }

    // 2. If a pending request already exists, leave it be (idempotent).
    const pending = await ctx.approvalDb!.getPendingToolRequest(toolKey, chatId);
    if (pending) {
      ctx.log(`human.approval: pending request ${pending.id} still awaiting operator.`);
      return { completed: true, summaryProse: `Awaiting approval (${pending.id})` };
    }

    // 3. Create a fresh pending request.
    const id = newId();
    await ctx.approvalDb!.createToolApprovalRequest({
      id,
      tool_name: toolKey,
      chat_id: chatId,
      user_id: null,
      input_json: JSON.stringify({ subject: inbound.subject, body: inbound.body }),
      policy_key: cfg.policyKey ?? null,
      skill_key: cfg.approvalKind,
      status: 'pending',
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
    });
    ctx.log(`human.approval: created request ${id} (${cfg.approvalKind}, tool=${toolKey}).`);
    return {
      completed: true,
      summaryProse: `Requested human approval (${cfg.approvalKind}) — request id ${id}.`,
    };
  };
}

export const humanApprovalHandler: HandlerKindRegistration = {
  kind: 'human.approval',
  description:
    'Dual-control gate. Records a tool_approval_requests row and waits for an ' +
    'operator to approve/deny it via the admin UI. Optionally forwards to a ' +
    'downstream agent once approved.',
  configSchema: {
    type: 'object',
    required: ['approvalKind', 'dualControlActions'],
    properties: {
      approvalKind: { type: 'string' },
      dualControlActions: { type: 'array', items: { type: 'string' }, minItems: 1 },
      policyKey: { type: 'string' },
      onApprovedSubject: { type: 'string' },
      onApprovedTo: { type: 'object' },
    },
  },
  factory: buildHumanApproval,
};
