import { describe, it, expect } from 'vitest';
import {
  neutralThemes,
  auditThemeContrast,
  resolveTenantTheme,
  applyTenantTheme,
  type ThemeName,
  type TenantThemeOverride,
} from './theme.js';

const THEME_NAMES: ThemeName[] = ['dark', 'light'];

describe('theme contrast audit (WCAG-AA)', () => {
  for (const name of THEME_NAMES) {
    const theme = neutralThemes[name];

    it(`${name}: every text-on-surface pair meets AA`, () => {
      const audit = auditThemeContrast(theme);
      if (!audit.pass) {
        // Surface the offending ratios in the failure message.
        const detail = audit.failures
          .map((f) => `${f.pair} = ${f.ratio} (need ${f.required}${f.large ? ' large' : ''})`)
          .join('; ');
        throw new Error(`${name} theme failed AA: ${detail}`);
      }
      expect(audit.pass).toBe(true);
      expect(audit.failures).toHaveLength(0);
    });

    it(`${name}: documents computed ratios for every audited pair`, () => {
      const audit = auditThemeContrast(theme);
      // Sanity: a known set of pairs is audited and ratios are in-range.
      expect(audit.pairs.length).toBeGreaterThanOrEqual(18);
      for (const p of audit.pairs) {
        expect(p.ratio).toBeGreaterThanOrEqual(1);
        expect(p.ratio).toBeLessThanOrEqual(21);
        expect(p.required).toBe(p.large ? 3 : 4.5);
      }
      // Emit the table so `vitest --reporter=verbose` shows the documented ratios.
      // eslint-disable-next-line no-console
      console.log(
        `\n[${name}] contrast ratios:\n` +
          audit.pairs.map((p) => `  ${p.pair.padEnd(34)} ${p.ratio.toFixed(2)} (>=${p.required})`).join('\n'),
      );
    });
  }
});

describe('per-tenant theming', () => {
  it('returns the base theme unchanged when no override is supplied', () => {
    expect(resolveTenantTheme(neutralThemes.dark)).toBe(neutralThemes.dark);
  });

  it('merges a color override without mutating the base theme', () => {
    const baseAccent = neutralThemes.dark.colors.accent;
    const override: TenantThemeOverride = { colors: { accent: '#44E0BE' } };
    const resolved = resolveTenantTheme(neutralThemes.dark, override);

    expect(resolved.colors.accent).toBe('#44E0BE');
    // Untouched tokens are preserved.
    expect(resolved.colors.background).toBe(neutralThemes.dark.colors.background);
    expect(resolved.typography).toBe(neutralThemes.dark.typography);
    // Base is not mutated.
    expect(neutralThemes.dark.colors.accent).toBe(baseAccent);
  });

  it('overrides font families and corner radii', () => {
    const resolved = resolveTenantTheme(neutralThemes.light, {
      typography: { families: { display: 'Lora' } },
      radii: { md: 4 },
    });
    expect(resolved.typography.families.display).toBe('Lora');
    // Other families fall through.
    expect(resolved.typography.families.body).toBe(neutralThemes.light.typography.families.body);
    expect(resolved.radii.md).toBe(4);
    expect(resolved.radii.lg).toBe(neutralThemes.light.radii.lg);
  });

  it('applies an AA-clean tenant brand', () => {
    const result = applyTenantTheme(neutralThemes.dark, { colors: { accentStrong: '#2FE0B6' } });
    expect(result.degraded).toBe(false);
    expect(result.audit.pass).toBe(true);
    expect(result.theme.colors.accentStrong).toBe('#2FE0B6');
  });

  it('audits — does not throw — a tenant override that breaks contrast', () => {
    // A near-background "text" color destroys readability.
    const broken: TenantThemeOverride = { colors: { text: '#101A15' } };
    const resolved = resolveTenantTheme(neutralThemes.dark, broken);
    const audit = auditThemeContrast(resolved);
    expect(audit.pass).toBe(false);
    expect(audit.failures.some((f) => f.foreground === 'text')).toBe(true);
  });

  it('degrades gracefully to the base theme when enforceContrast rejects an override', () => {
    const result = applyTenantTheme(neutralThemes.dark, { colors: { text: '#101A15' } });
    expect(result.degraded).toBe(true);
    expect(result.theme).toBe(neutralThemes.dark); // fell back to base
    expect(result.audit.pass).toBe(false);
  });

  it('honors enforceContrast:false to keep a failing override (opt-in)', () => {
    const result = applyTenantTheme(
      neutralThemes.dark,
      { colors: { text: '#101A15' } },
      { enforceContrast: false },
    );
    expect(result.degraded).toBe(false);
    expect(result.theme.colors.text).toBe('#101A15');
    expect(result.audit.pass).toBe(false);
  });
});
