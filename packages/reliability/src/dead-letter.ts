import { randomUUID } from 'node:crypto';

export interface DeadLetterRecord {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly error: string;
  readonly firstFailedAt: string;
  readonly lastFailedAt: string;
  readonly retryCount: number;
  resolved: boolean;
}

export interface DeadLetterQueue {
  enqueue(record: Omit<DeadLetterRecord, 'id' | 'firstFailedAt' | 'lastFailedAt' | 'resolved'>): DeadLetterRecord;
  dequeue(id: string): boolean;
  list(filter?: { type?: string; resolved?: boolean }): readonly DeadLetterRecord[];
  retry(id: string, fn: (payload: unknown) => Promise<void>): Promise<boolean>;
  clear(): number;
}

export function createDeadLetterQueue(): DeadLetterQueue {
  const records = new Map<string, DeadLetterRecord>();

  return {
    enqueue(input): DeadLetterRecord {
      const now = new Date().toISOString();
      const record: DeadLetterRecord = {
        id: randomUUID(),
        type: input.type,
        payload: input.payload,
        error: input.error,
        retryCount: input.retryCount,
        firstFailedAt: now,
        lastFailedAt: now,
        resolved: false,
      };
      records.set(record.id, record);
      return record;
    },

    dequeue(id: string): boolean {
      const record = records.get(id);
      if (record === undefined) {
        return false;
      }
      record.resolved = true;
      return true;
    },

    list(filter?: { type?: string; resolved?: boolean }): readonly DeadLetterRecord[] {
      let results = Array.from(records.values());
      if (filter?.type !== undefined) {
        results = results.filter((r) => r.type === filter.type);
      }
      if (filter?.resolved !== undefined) {
        results = results.filter((r) => r.resolved === filter.resolved);
      }
      return results;
    },

    async retry(id: string, fn: (payload: unknown) => Promise<void>): Promise<boolean> {
      const record = records.get(id);
      if (record === undefined || record.resolved) {
        return false;
      }
      try {
        await fn(record.payload);
        record.resolved = true;
        return true;
      } catch {
        const updated: DeadLetterRecord = {
          ...record,
          retryCount: record.retryCount + 1,
          lastFailedAt: new Date().toISOString(),
          resolved: false,
        };
        records.set(id, updated);
        return false;
      }
    },

    clear(): number {
      let removed = 0;
      for (const [id, record] of records) {
        if (record.resolved) {
          records.delete(id);
          removed++;
        }
      }
      return removed;
    },
  };
}
