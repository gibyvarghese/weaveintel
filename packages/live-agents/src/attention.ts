import type { AttentionAction, AttentionContext, AttentionPolicy } from './types.js';

function nextTickIso(nowIso: string, minutes: number): string {
  return new Date(Date.parse(nowIso) + minutes * 60_000).toISOString();
}

export function createStandardAttentionPolicy(): AttentionPolicy {
  return {
    key: 'standard-v1',
    async decide(context): Promise<AttentionAction> {
      const pendingMessage = context.inbox.find((message) => message.status === 'PENDING' || message.status === 'DELIVERED');
      if (pendingMessage) {
        return { type: 'ProcessMessage', messageId: pendingMessage.id };
      }

      const inProgress = context.backlog.find((item) => item.status === 'IN_PROGRESS');
      if (inProgress) {
        return { type: 'ContinueTask', backlogItemId: inProgress.id };
      }

      const accepted = context.backlog.find((item) => item.status === 'ACCEPTED' || item.status === 'PROPOSED');
      if (accepted) {
        return { type: 'StartTask', backlogItemId: accepted.id };
      }

      return {
        type: 'CheckpointAndRest',
        nextTickAt: nextTickIso(context.nowIso, 15),
      };
    },
  };
}
