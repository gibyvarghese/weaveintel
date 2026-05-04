/**
 * Internal helper used by Phase 6 generic handlers to push a downstream
 * message AND seed a corresponding ACCEPTED `BacklogItem` at the recipient.
 *
 * This is the glue that lets a chain of deterministic / template / approval
 * agents progress under the standard inbox-first attention policy. Without
 * the backlog item, the recipient's standard policy would emit
 * `ProcessMessage` and silently mark the inbound TASK PROCESSED — never
 * invoking the recipient's TaskHandler.
 *
 * BROADCAST messages skip the backlog seed (no single recipient).
 */

import type {
  ActionExecutionContext,
  BacklogItem,
  Message,
} from '@weaveintel/live-agents';

export interface EnqueueDownstreamArgs {
  execCtx: ActionExecutionContext;
  message: Message;
  /** Title rendered into the recipient's backlog. Defaults to the message subject. */
  backlogTitle?: string;
  /** Description rendered into the recipient's backlog. Defaults to "Triggered by message <id>". */
  backlogDescription?: string;
}

function makeId(prefix: string, nowIso: string): string {
  return `${prefix}_${Date.parse(nowIso)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Save the outbound message and (for AGENT recipients) seed an ACCEPTED
 * backlog item so the recipient's next tick yields a StartTask action.
 */
export async function enqueueDownstreamTask(
  args: EnqueueDownstreamArgs,
): Promise<{ messageId: string; backlogItemId: string | null }> {
  const { execCtx, message } = args;
  await execCtx.stateStore.saveMessage(message);

  if (message.toType !== 'AGENT' || !message.toId) {
    return { messageId: message.id, backlogItemId: null };
  }

  const backlog: BacklogItem = {
    id: makeId('blg', execCtx.nowIso),
    agentId: message.toId,
    priority: message.priority,
    status: 'ACCEPTED',
    originType: 'MESSAGE',
    originRef: message.id,
    blockedOnMessageId: null,
    blockedOnGrantRequestId: null,
    blockedOnPromotionRequestId: null,
    blockedOnAccountBindingRequestId: null,
    estimatedEffort: 'small',
    deadline: null,
    acceptedAt: execCtx.nowIso,
    startedAt: null,
    completedAt: null,
    createdAt: execCtx.nowIso,
    title: args.backlogTitle ?? message.subject,
    description: args.backlogDescription ?? `Triggered by message ${message.id}`,
  };
  await execCtx.stateStore.saveBacklogItem(backlog);
  return { messageId: message.id, backlogItemId: backlog.id };
}
