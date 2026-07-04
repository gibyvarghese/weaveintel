import { describe, it, expect } from 'vitest';
import {
  TOKENS_SCHEMA_VERSION,
  SPACING_BASE_UNIT,
  neutralThemes,
  spacing,
  radii,
  typography,
  motion,
  neutralDark,
  neutralLight,
} from './index.js';

describe('@weaveintel/tokens barrel', () => {
  it('exports a stable schema version', () => {
    expect(TOKENS_SCHEMA_VERSION).toBe(1);
  });

  it('exports the 4-pt spacing base unit and a grid built on it', () => {
    expect(SPACING_BASE_UNIT).toBe(4);
    expect(spacing.lg % SPACING_BASE_UNIT).toBe(0);
    expect(spacing.md).toBe(12);
  });

  it('exposes assembled dark and light neutralThemes with all token groups', () => {
    for (const name of ['dark', 'light'] as const) {
      const t = neutralThemes[name];
      expect(t.name).toBe(name);
      expect(t.colors).toBe(name === 'dark' ? neutralDark : neutralLight);
      expect(t.typography).toBe(typography);
      expect(t.spacing).toBe(spacing);
      expect(t.radii).toBe(radii);
      expect(t.motion).toBe(motion);
    }
  });

  it('defines NEUTRAL default font families (apps override with their own brand fonts)', () => {
    expect(typography.families).toEqual({
      display: 'system-ui',
      body: 'system-ui',
      mono: 'ui-monospace',
      hand: 'cursive',
    });
  });

  it('exposes a weave-shimmer spec driven by the accent tokens', () => {
    expect(motion.weaveShimmer.colorStops).toEqual(['accentSoft', 'accent', 'accentSoft']);
    expect(motion.weaveShimmer.durationMs).toBeGreaterThan(0);
  });
});
