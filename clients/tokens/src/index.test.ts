import { describe, it, expect } from 'vitest';
import {
  TOKENS_SCHEMA_VERSION,
  SPACING_BASE_UNIT,
  themes,
  spacing,
  radii,
  typography,
  motion,
  darkColors,
  lightColors,
} from './index.js';

describe('@geneweave/tokens barrel', () => {
  it('exports a stable schema version', () => {
    expect(TOKENS_SCHEMA_VERSION).toBe(1);
  });

  it('exports the 4-pt spacing base unit and a grid built on it', () => {
    expect(SPACING_BASE_UNIT).toBe(4);
    expect(spacing.lg % SPACING_BASE_UNIT).toBe(0);
    expect(spacing.md).toBe(12);
  });

  it('exposes assembled dark and light themes with all token groups', () => {
    for (const name of ['dark', 'light'] as const) {
      const t = themes[name];
      expect(t.name).toBe(name);
      expect(t.colors).toBe(name === 'dark' ? darkColors : lightColors);
      expect(t.typography).toBe(typography);
      expect(t.spacing).toBe(spacing);
      expect(t.radii).toBe(radii);
      expect(t.motion).toBe(motion);
    }
  });

  it('defines the three brand font families', () => {
    expect(typography.families).toEqual({
      display: 'Fraunces',
      body: 'Plus Jakarta Sans',
      mono: 'DM Mono',
    });
  });

  it('exposes a weave-shimmer spec driven by the accent tokens', () => {
    expect(motion.weaveShimmer.colorStops).toEqual(['accentSoft', 'accent', 'accentSoft']);
    expect(motion.weaveShimmer.durationMs).toBeGreaterThan(0);
  });
});
