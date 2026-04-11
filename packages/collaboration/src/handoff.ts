// @weaveintel/collaboration — User handoff & presence coordination

export type HandoffStatus = 'requested' | 'accepted' | 'rejected' | 'cancelled' | 'completed';

export interface HandoffRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly reason: string;
  readonly status: HandoffStatus;
  readonly createdAt: number;
  readonly resolvedAt: number | null;
  readonly metadata: Record<string, unknown>;
}

export interface HandoffManager {
  request(sessionId: string, fromUserId: string, toUserId: string, reason: string): HandoffRequest;
  accept(handoffId: string): HandoffRequest | undefined;
  reject(handoffId: string, reason?: string): HandoffRequest | undefined;
  cancel(handoffId: string): HandoffRequest | undefined;
  complete(handoffId: string): HandoffRequest | undefined;
  get(handoffId: string): HandoffRequest | undefined;
  listBySession(sessionId: string): readonly HandoffRequest[];
}

export function createHandoffManager(): HandoffManager {
  const requests = new Map<string, HandoffRequest>();

  function nextId(): string {
    return `hoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function transition(id: string, status: HandoffStatus): HandoffRequest | undefined {
    const existing = requests.get(id);
    if (!existing) return undefined;
    const updated: HandoffRequest = { ...existing, status, resolvedAt: status === 'requested' ? null : Date.now() };
    requests.set(id, updated);
    return updated;
  }

  return {
    request(sessionId, fromUserId, toUserId, reason) {
      const req: HandoffRequest = {
        id: nextId(), sessionId, fromUserId, toUserId, reason,
        status: 'requested', createdAt: Date.now(), resolvedAt: null, metadata: {},
      };
      requests.set(req.id, req);
      return req;
    },

    accept(handoffId) { return transition(handoffId, 'accepted'); },
    reject(handoffId) { return transition(handoffId, 'rejected'); },
    cancel(handoffId) { return transition(handoffId, 'cancelled'); },
    complete(handoffId) { return transition(handoffId, 'completed'); },

    get(handoffId) { return requests.get(handoffId); },

    listBySession(sessionId) {
      return Array.from(requests.values()).filter((r) => r.sessionId === sessionId);
    },
  };
}
