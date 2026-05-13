import { describe, it, expect, vi } from 'vitest';
import {
  decideIntelGating,
  weaveIntelGate,
  shouldKeepSection,
  INTEL_HEADER_SECTION,
  INTEL_SNIPPETS_SECTION,
  type IntelScoreProvider,
} from './intel-gating.js';
import type { IntelGatingConfig } from './policy.js';

describe('decideIntelGating (pure)', () => {
  const cfg: IntelGatingConfig = { enabled: true, thresholds: { low: 0.4, high: 0.7 } };

  it('keeps everything when config is null', () => {
    const d = decideIntelGating(null, 0.99);
    expect(d.keepIntelHeader).toBe(true);
    expect(d.keepSnippets).toBe(true);
    expect(d.reason).toBe('no-config');
  });

  it('keeps everything when config.enabled = false', () => {
    const d = decideIntelGating({ enabled: false }, 0.99);
    expect(d.keepIntelHeader).toBe(true);
    expect(d.keepSnippets).toBe(true);
    expect(d.reason).toBe('disabled');
  });

  it('keeps everything when score is null (cold start)', () => {
    const d = decideIntelGating(cfg, null);
    expect(d.keepIntelHeader).toBe(true);
    expect(d.keepSnippets).toBe(true);
    expect(d.score).toBeNull();
  });

  it('keeps everything when score is NaN', () => {
    const d = decideIntelGating(cfg, Number.NaN);
    expect(d.keepIntelHeader).toBe(true);
    expect(d.keepSnippets).toBe(true);
  });

  it('drops both at high threshold', () => {
    const d = decideIntelGating(cfg, 0.85);
    expect(d.keepIntelHeader).toBe(false);
    expect(d.keepSnippets).toBe(false);
  });

  it('drops both exactly at high threshold (>=)', () => {
    const d = decideIntelGating(cfg, 0.7);
    expect(d.keepIntelHeader).toBe(false);
    expect(d.keepSnippets).toBe(false);
  });

  it('drops snippets only between low and high', () => {
    const d = decideIntelGating(cfg, 0.55);
    expect(d.keepIntelHeader).toBe(true);
    expect(d.keepSnippets).toBe(false);
  });

  it('keeps everything below low threshold', () => {
    const d = decideIntelGating(cfg, 0.2);
    expect(d.keepIntelHeader).toBe(true);
    expect(d.keepSnippets).toBe(true);
  });

  it('clamps score above 1', () => {
    const d = decideIntelGating(cfg, 1.5);
    expect(d.score).toBe(1);
    expect(d.keepIntelHeader).toBe(false);
  });

  it('clamps score below 0', () => {
    const d = decideIntelGating(cfg, -0.3);
    expect(d.score).toBe(0);
    expect(d.keepIntelHeader).toBe(true);
    expect(d.keepSnippets).toBe(true);
  });

  it('uses default thresholds when omitted (low=0.4, high=0.7)', () => {
    const d1 = decideIntelGating({ enabled: true }, 0.5);
    expect(d1.keepIntelHeader).toBe(true);
    expect(d1.keepSnippets).toBe(false);
    const d2 = decideIntelGating({ enabled: true }, 0.8);
    expect(d2.keepIntelHeader).toBe(false);
  });
});

describe('weaveIntelGate factory', () => {
  const cfg: IntelGatingConfig = { enabled: true, thresholds: { low: 0.4, high: 0.7 } };

  it('returns null shape when both sections should be kept (cold start)', async () => {
    const provider: IntelScoreProvider = { compute: async () => 0.1 };
    const shaper = weaveIntelGate(cfg, provider);
    const shape = await shaper({});
    expect(shape).toBeNull();
  });

  it('drops intel snippets only at mid score', async () => {
    const provider: IntelScoreProvider = { compute: async () => 0.55 };
    const shaper = weaveIntelGate(cfg, provider);
    const shape = await shaper({});
    expect(shape).not.toBeNull();
    expect(shape!.dropSections).toContain(INTEL_SNIPPETS_SECTION);
    expect(shape!.dropSections).not.toContain(INTEL_HEADER_SECTION);
  });

  it('drops both at high score', async () => {
    const provider: IntelScoreProvider = { compute: async () => 0.9 };
    const shaper = weaveIntelGate(cfg, provider);
    const shape = await shaper({});
    expect(shape!.dropSections).toContain(INTEL_HEADER_SECTION);
    expect(shape!.dropSections).toContain(INTEL_SNIPPETS_SECTION);
  });

  it('treats provider null as cold start (keeps everything → null shape)', async () => {
    const provider: IntelScoreProvider = { compute: async () => null };
    const shaper = weaveIntelGate(cfg, provider);
    expect(await shaper({})).toBeNull();
  });

  it('catches provider throw and falls back to keep-everything', async () => {
    const provider: IntelScoreProvider = {
      compute: async () => {
        throw new Error('db down');
      },
    };
    const log = vi.fn();
    const shaper = weaveIntelGate(cfg, provider, { log });
    const shape = await shaper({});
    expect(shape).toBeNull();
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toMatch(/db down/);
  });

  it('forwards lever context to provider', async () => {
    const provider: IntelScoreProvider = { compute: vi.fn(async () => 0.5) };
    const shaper = weaveIntelGate(cfg, provider);
    await shaper({ meshId: 'M', agentId: 'A', phase: 'kernel' });
    expect(provider.compute).toHaveBeenCalledWith(
      expect.objectContaining({ meshId: 'M', agentId: 'A', phase: 'kernel' }),
    );
  });
});

describe('shouldKeepSection helper', () => {
  it('keeps when shape is null', () => {
    expect(shouldKeepSection(null, INTEL_HEADER_SECTION)).toBe(true);
  });
  it('drops when in dropSections', () => {
    expect(shouldKeepSection({ dropSections: [INTEL_HEADER_SECTION] }, INTEL_HEADER_SECTION)).toBe(false);
  });
  it('keeps when in keepSections allowlist', () => {
    expect(shouldKeepSection({ keepSections: ['intel_header'] }, 'intel_header')).toBe(true);
  });
  it('drops when keepSections allowlist excludes', () => {
    expect(shouldKeepSection({ keepSections: ['system'] }, 'intel_header')).toBe(false);
  });
});
