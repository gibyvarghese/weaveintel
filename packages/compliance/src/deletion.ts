// @weaveintel/compliance — Right-to-delete requests

export type DeletionStatus = 'pending' | 'in-progress' | 'completed' | 'failed' | 'blocked';

export interface DeletionRequest {
  readonly id: string;
  readonly subjectId: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly status: DeletionStatus;
  readonly dataCategories: readonly string[];
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly blockedReason: string | null;
}

export interface DeletionManager {
  create(subjectId: string, requestedBy: string, reason: string, dataCategories: string[]): DeletionRequest;
  get(id: string): DeletionRequest | undefined;
  list(): readonly DeletionRequest[];
  process(id: string): DeletionRequest | undefined;
  complete(id: string): DeletionRequest | undefined;
  fail(id: string, reason: string): DeletionRequest | undefined;
  block(id: string, reason: string): DeletionRequest | undefined;
}

export function createDeletionManager(): DeletionManager {
  const requests = new Map<string, DeletionRequest>();

  function nextId(): string {
    return `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function update(id: string, patch: Partial<DeletionRequest>): DeletionRequest | undefined {
    const existing = requests.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch } as DeletionRequest;
    requests.set(id, updated);
    return updated;
  }

  return {
    create(subjectId, requestedBy, reason, dataCategories) {
      const req: DeletionRequest = {
        id: nextId(), subjectId, requestedBy, reason, status: 'pending',
        dataCategories, createdAt: Date.now(), completedAt: null, blockedReason: null,
      };
      requests.set(req.id, req);
      return req;
    },
    get(id) { return requests.get(id); },
    list() { return Array.from(requests.values()); },
    process(id) { return update(id, { status: 'in-progress' }); },
    complete(id) { return update(id, { status: 'completed', completedAt: Date.now() }); },
    fail(id, reason) { return update(id, { status: 'failed', blockedReason: reason }); },
    block(id, reason) { return update(id, { status: 'blocked', blockedReason: reason }); },
  };
}
