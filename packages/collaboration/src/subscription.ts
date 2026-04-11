// @weaveintel/collaboration — Live run subscriptions

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface RunSubscription {
  readonly runId: string;
  readonly sessionId: string;
  readonly subscriberId: string;
  readonly status: RunStatus;
  readonly progress: number; // 0.0 – 1.0
  readonly lastUpdate: number;
  readonly metadata: Record<string, unknown>;
}

export interface RunSubscriptionManager {
  subscribe(runId: string, sessionId: string, subscriberId: string): RunSubscription;
  updateStatus(runId: string, status: RunStatus, progress?: number): RunSubscription | undefined;
  getSubscription(runId: string, subscriberId: string): RunSubscription | undefined;
  listBySession(sessionId: string): readonly RunSubscription[];
  unsubscribe(runId: string, subscriberId: string): void;
}

export function createRunSubscriptionManager(): RunSubscriptionManager {
  const subs = new Map<string, RunSubscription>();

  function key(runId: string, subscriberId: string): string {
    return `${runId}:${subscriberId}`;
  }

  return {
    subscribe(runId, sessionId, subscriberId) {
      const sub: RunSubscription = { runId, sessionId, subscriberId, status: 'pending', progress: 0, lastUpdate: Date.now(), metadata: {} };
      subs.set(key(runId, subscriberId), sub);
      return sub;
    },

    updateStatus(runId, status, progress) {
      for (const [k, v] of subs.entries()) {
        if (v.runId === runId) {
          const updated = { ...v, status, progress: progress ?? v.progress, lastUpdate: Date.now() };
          subs.set(k, updated);
        }
      }
      return Array.from(subs.values()).find((s) => s.runId === runId);
    },

    getSubscription(runId, subscriberId) {
      return subs.get(key(runId, subscriberId));
    },

    listBySession(sessionId) {
      return Array.from(subs.values()).filter((s) => s.sessionId === sessionId);
    },

    unsubscribe(runId, subscriberId) {
      subs.delete(key(runId, subscriberId));
    },
  };
}
