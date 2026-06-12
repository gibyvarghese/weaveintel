/**
 * spacing.ts — geneWeave spacing, radii, and elevation scales.
 *
 * Spacing is a strict 4-pt grid. Elevation shadow specs are theme-dependent
 * (dark surfaces use deeper black shadows), so the elevation ramps are keyed
 * by theme and assembled into the final Theme in theme.ts.
 */

/** Base spacing unit (points). The whole spacing scale is a multiple of this. */
export const SPACING_BASE_UNIT = 4 as const;

/** Named spacing steps on the 4-pt grid. */
export interface SpacingScale {
  none: number;
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  xxl: number;
  xxxl: number;
}

export const spacing: SpacingScale = {
  none: 0,
  xs: SPACING_BASE_UNIT * 1, // 4
  sm: SPACING_BASE_UNIT * 2, // 8
  md: SPACING_BASE_UNIT * 3, // 12
  lg: SPACING_BASE_UNIT * 4, // 16
  xl: SPACING_BASE_UNIT * 6, // 24
  xxl: SPACING_BASE_UNIT * 8, // 32
  xxxl: SPACING_BASE_UNIT * 12, // 48
};

/** Corner radius scale. `pill`/`full` are effectively fully rounded. */
export interface RadiiScale {
  none: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  pill: number;
  full: number;
}

export const radii: RadiiScale = {
  none: 0,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
  full: 9999,
};

/**
 * A single elevation level. Shape is React Native-friendly (iOS shadow* props
 * + Android `elevation`) but contains only plain data, no RN import.
 */
export interface ElevationLevel {
  shadowColor: string;
  shadowOpacity: number;
  shadowRadius: number;
  shadowOffset: { width: number; height: number };
  /** Android elevation (dp). */
  elevation: number;
}

/** Four elevation levels: flat, raised card, overlay, modal. */
export interface ElevationScale {
  level0: ElevationLevel;
  level1: ElevationLevel;
  level2: ElevationLevel;
  level3: ElevationLevel;
}

export const darkElevation: ElevationScale = {
  level0: { shadowColor: '#000000', shadowOpacity: 0, shadowRadius: 0, shadowOffset: { width: 0, height: 0 }, elevation: 0 },
  level1: { shadowColor: '#000000', shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  level2: { shadowColor: '#000000', shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 6 },
  level3: { shadowColor: '#000000', shadowOpacity: 0.45, shadowRadius: 32, shadowOffset: { width: 0, height: 16 }, elevation: 16 },
};

export const lightElevation: ElevationScale = {
  level0: { shadowColor: '#1A2B23', shadowOpacity: 0, shadowRadius: 0, shadowOffset: { width: 0, height: 0 }, elevation: 0 },
  level1: { shadowColor: '#1A2B23', shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  level2: { shadowColor: '#1A2B23', shadowOpacity: 0.1, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 6 },
  level3: { shadowColor: '#1A2B23', shadowOpacity: 0.12, shadowRadius: 32, shadowOffset: { width: 0, height: 16 }, elevation: 16 },
};
