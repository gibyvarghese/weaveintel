// @weaveintel/compliance — Processing consent flags

export type ConsentPurpose = 'analytics' | 'training' | 'personalization' | 'marketing' | 'research' | 'third-party';

export interface ConsentFlag {
  readonly subjectId: string;
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  readonly grantedAt: number;
  readonly expiresAt: number | null;
  readonly source: string;
}

export interface ConsentManager {
  grant(subjectId: string, purpose: ConsentPurpose, source: string, expiresAt?: number): ConsentFlag;
  revoke(subjectId: string, purpose: ConsentPurpose): boolean;
  isGranted(subjectId: string, purpose: ConsentPurpose): boolean;
  listBySubject(subjectId: string): readonly ConsentFlag[];
  listByPurpose(purpose: ConsentPurpose): readonly ConsentFlag[];
}

export function createConsentManager(): ConsentManager {
  const flags = new Map<string, ConsentFlag>();

  function key(subjectId: string, purpose: ConsentPurpose): string {
    return `${subjectId}:${purpose}`;
  }

  return {
    grant(subjectId, purpose, source, expiresAt) {
      const flag: ConsentFlag = { subjectId, purpose, granted: true, grantedAt: Date.now(), expiresAt: expiresAt ?? null, source };
      flags.set(key(subjectId, purpose), flag);
      return flag;
    },

    revoke(subjectId, purpose) {
      return flags.delete(key(subjectId, purpose));
    },

    isGranted(subjectId, purpose) {
      const flag = flags.get(key(subjectId, purpose));
      if (!flag || !flag.granted) return false;
      if (flag.expiresAt && Date.now() > flag.expiresAt) return false;
      return true;
    },

    listBySubject(subjectId) {
      return Array.from(flags.values()).filter((f) => f.subjectId === subjectId);
    },

    listByPurpose(purpose) {
      return Array.from(flags.values()).filter((f) => f.purpose === purpose);
    },
  };
}
