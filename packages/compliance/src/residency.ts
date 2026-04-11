// @weaveintel/compliance — Data residency constraints

export interface ResidencyConstraint {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly region: string;
  readonly dataCategories: readonly string[];
  readonly allowedRegions: readonly string[];
  readonly deniedRegions: readonly string[];
  readonly enabled: boolean;
}

export interface ResidencyEngine {
  addConstraint(constraint: ResidencyConstraint): void;
  getConstraint(id: string): ResidencyConstraint | undefined;
  listConstraints(): readonly ResidencyConstraint[];
  removeConstraint(id: string): boolean;
  isAllowed(dataCategory: string, targetRegion: string): boolean;
  getAllowedRegions(dataCategory: string): readonly string[];
}

export function createResidencyEngine(): ResidencyEngine {
  const constraints = new Map<string, ResidencyConstraint>();

  return {
    addConstraint(c) { constraints.set(c.id, c); },
    getConstraint(id) { return constraints.get(id); },
    listConstraints() { return Array.from(constraints.values()); },
    removeConstraint(id) { return constraints.delete(id); },

    isAllowed(dataCategory, targetRegion) {
      for (const c of constraints.values()) {
        if (!c.enabled) continue;
        if (!c.dataCategories.includes(dataCategory) && !c.dataCategories.includes('*')) continue;
        if (c.deniedRegions.includes(targetRegion)) return false;
        if (c.allowedRegions.length > 0 && !c.allowedRegions.includes(targetRegion)) return false;
      }
      return true;
    },

    getAllowedRegions(dataCategory) {
      const allowed = new Set<string>();
      for (const c of constraints.values()) {
        if (!c.enabled) continue;
        if (!c.dataCategories.includes(dataCategory) && !c.dataCategories.includes('*')) continue;
        for (const r of c.allowedRegions) allowed.add(r);
      }
      return Array.from(allowed);
    },
  };
}
