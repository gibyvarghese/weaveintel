// @weaveintel/compliance — Legal hold management

export type LegalHoldStatus = 'active' | 'released' | 'expired';

export interface LegalHold {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly subjectIds: readonly string[];
  readonly dataCategories: readonly string[];
  readonly status: LegalHoldStatus;
  readonly issuedBy: string;
  readonly issuedAt: number;
  readonly expiresAt: number | null;
  readonly releasedAt: number | null;
}

export interface LegalHoldManager {
  create(hold: Omit<LegalHold, 'issuedAt' | 'releasedAt' | 'status'>): LegalHold;
  get(id: string): LegalHold | undefined;
  list(): readonly LegalHold[];
  release(id: string): LegalHold | undefined;
  isHeld(subjectId: string, dataCategory: string): boolean;
}

export function createLegalHoldManager(): LegalHoldManager {
  const holds = new Map<string, LegalHold>();

  return {
    create(hold) {
      const h: LegalHold = { ...hold, status: 'active', issuedAt: Date.now(), releasedAt: null };
      holds.set(h.id, h);
      return h;
    },
    get(id) { return holds.get(id); },
    list() { return Array.from(holds.values()); },
    release(id) {
      const existing = holds.get(id);
      if (!existing) return undefined;
      const updated: LegalHold = { ...existing, status: 'released', releasedAt: Date.now() };
      holds.set(id, updated);
      return updated;
    },
    isHeld(subjectId, dataCategory) {
      for (const hold of holds.values()) {
        if (hold.status !== 'active') continue;
        if (hold.expiresAt && Date.now() > hold.expiresAt) continue;
        const subjectMatch = hold.subjectIds.includes(subjectId) || hold.subjectIds.includes('*');
        const categoryMatch = hold.dataCategories.includes(dataCategory) || hold.dataCategories.includes('*');
        if (subjectMatch && categoryMatch) return true;
      }
      return false;
    },
  };
}
