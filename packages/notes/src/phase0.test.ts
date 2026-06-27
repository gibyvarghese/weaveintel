// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 0 — unit tests for the shared foundation: the agency-colour contract, the
 * suggestion state machine, the capability config validator, and the node registry. Covers
 * positive, negative, stress, and security/abuse cases.
 */
import { describe, it, expect } from 'vitest';
import {
  AGENCY_PALETTE, authorStyle, aiByline, isAiSignalColor, aiContentPalette,
  emptySuggestions, addSuggestion, acceptSuggestion, rejectSuggestion, resolveAll, clearResolved, pendingCount, pendingQueue, decisionTag,
  DEFAULT_WEAVENOTES_CONFIG, validateWeaveNotesConfig, WEAVENOTES_AI_TOOLS,
  NOTE_NODE_REGISTRY, noteNodeSpec, aiCreatableNodes, editableNodes,
} from './index.js';

describe('agency-colour contract', () => {
  it('user content is neutral with no byline; AI content is mint + emerald edge + byline; human ink is coral', () => {
    expect(authorStyle('user')).toMatchObject({ surface: AGENCY_PALETTE.surface, foreground: AGENCY_PALETTE.ink, showByline: false });
    const ai = authorStyle('ai');
    expect(ai).toMatchObject({ surface: AGENCY_PALETTE.mint, foreground: AGENCY_PALETTE.emeraldPress, edge: AGENCY_PALETTE.emerald, showByline: true });
    expect(authorStyle('human-ink').foreground).toBe(AGENCY_PALETTE.coral);
  });
  it('byline labels the AI block by what it made', () => {
    expect(aiByline()).toBe('geneWeave AI');
    expect(aiByline('mind map')).toBe('geneWeave AI · mind map');
    expect(aiByline('  ')).toBe('geneWeave AI'); // blank kind ignored
  });
  it('emerald/mint are reserved AI-signal colours; the AI palette excludes them (so it never paints user content "AI")', () => {
    expect(isAiSignalColor(AGENCY_PALETTE.emerald)).toBe(true);
    expect(isAiSignalColor('#0E9A6E'.toUpperCase())).toBe(true); // case-insensitive
    expect(isAiSignalColor(AGENCY_PALETTE.coral)).toBe(false);
    const palette = aiContentPalette().map((c) => c.hex.toLowerCase());
    expect(palette).not.toContain(AGENCY_PALETTE.emerald.toLowerCase());
    expect(palette).not.toContain(AGENCY_PALETTE.mint.toLowerCase());
  });
});

describe('suggestion state machine', () => {
  const mk = (id: string, t = 0) => ({ id, kind: 'text-edit' as const, summary: `edit ${id}`, createdAt: t });
  it('adds, accepts, rejects, and counts pending', () => {
    let m = emptySuggestions();
    m = addSuggestion(m, mk('a', 1)); m = addSuggestion(m, mk('b', 2)); m = addSuggestion(m, mk('c', 3));
    expect(pendingCount(m)).toBe(3);
    m = acceptSuggestion(m, 'a'); m = rejectSuggestion(m, 'b');
    expect(pendingCount(m)).toBe(1);
    expect(m['a']!.state).toBe('accepted');
    expect(m['b']!.state).toBe('rejected');
    expect(decisionTag(m['a']!.state)).toBe('AI edit accepted');
    expect(decisionTag(m['b']!.state)).toBe('kept yours');
  });
  it('is idempotent on add and resolve (re-adding keeps existing; re-resolving a resolved one is a no-op)', () => {
    let m = addSuggestion(emptySuggestions(), { ...mk('a'), summary: 'first' });
    m = addSuggestion(m, { ...mk('a'), summary: 'second' }); // ignored
    expect(m['a']!.summary).toBe('first');
    m = acceptSuggestion(m, 'a');
    m = rejectSuggestion(m, 'a'); // already accepted → no-op
    expect(m['a']!.state).toBe('accepted');
  });
  it('resolveSuggestion on a missing id is a no-op (does not crash or create entries)', () => {
    const m = acceptSuggestion(emptySuggestions(), 'ghost');
    expect(Object.keys(m)).toHaveLength(0);
  });
  it('pendingQueue is oldest-first; resolveAll + clearResolved housekeep', () => {
    let m = emptySuggestions();
    m = addSuggestion(m, mk('c', 30)); m = addSuggestion(m, mk('a', 10)); m = addSuggestion(m, mk('b', 20));
    expect(pendingQueue(m).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    m = resolveAll(m, 'accepted');
    expect(pendingCount(m)).toBe(0);
    expect(clearResolved(m)).toEqual({});
  });
  it('STRESS: 5,000 suggestions add/resolve in O(n) without blowing up', () => {
    let m = emptySuggestions();
    for (let i = 0; i < 5000; i++) m = addSuggestion(m, mk(`s${i}`, i));
    expect(pendingCount(m)).toBe(5000);
    for (let i = 0; i < 5000; i += 2) m = acceptSuggestion(m, `s${i}`);
    expect(pendingCount(m)).toBe(2500);
  });
});

describe('weaveNotes config validator', () => {
  it('accepts a valid partial and fills the rest from defaults', () => {
    const { config, warnings } = validateWeaveNotesConfig({ defaultTheme: 'creative', maxAiTokensPerEdit: 8000 });
    expect(config.defaultTheme).toBe('creative');
    expect(config.maxAiTokensPerEdit).toBe(8000);
    expect(config.activityRetentionDays).toBe(DEFAULT_WEAVENOTES_CONFIG.activityRetentionDays);
    expect(warnings).toHaveLength(0);
  });
  it('NEGATIVE: clamps out-of-range numbers + warns; rejects unknown theme + unknown tools', () => {
    const { config, warnings } = validateWeaveNotesConfig({
      defaultTheme: 'rainbow', activityRetentionDays: 99999, maxAiTokensPerEdit: 1,
      enabledAiTools: ['note_edit', 'rm -rf /', 'workspace_search', 'note_edit'],
    });
    expect(config.defaultTheme).toBe('pro');            // unknown theme rejected
    expect(config.activityRetentionDays).toBe(3650);    // clamped to max
    expect(config.maxAiTokensPerEdit).toBe(256);        // clamped to min
    expect(config.enabledAiTools.sort()).toEqual(['note_edit', 'workspace_search']); // unknown dropped + deduped
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });
  it('SECURITY: a hostile/garbage payload can never produce an invalid config', () => {
    const evil = { defaultTheme: { toString: () => 'pro' }, activityRetentionDays: 'NaN; DROP TABLE notes', maxAiTokensPerEdit: Infinity, enabledAiTools: 'not-an-array', agencyColorEnabled: 'yes-please' };
    const { config } = validateWeaveNotesConfig(evil as never);
    expect(['pro', 'creative']).toContain(config.defaultTheme);
    expect(Number.isInteger(config.activityRetentionDays)).toBe(true);
    expect(config.maxAiTokensPerEdit).toBeLessThanOrEqual(200_000);
    expect(Array.isArray(config.enabledAiTools)).toBe(true);
    expect(config.enabledAiTools.every((t) => (WEAVENOTES_AI_TOOLS as readonly string[]).includes(t))).toBe(true);
  });
  it('null/undefined input returns the safe defaults', () => {
    expect(validateWeaveNotesConfig(null).config).toEqual(DEFAULT_WEAVENOTES_CONFIG);
    expect(validateWeaveNotesConfig(undefined).config).toEqual(DEFAULT_WEAVENOTES_CONFIG);
  });
});

describe('note-node registry', () => {
  it('every node has a label + flags; lookups work', () => {
    expect(NOTE_NODE_REGISTRY.length).toBeGreaterThan(15);
    expect(noteNodeSpec('inkCanvas')).toMatchObject({ label: 'Ink', aiCreatable: true, editableAfter: true, phase: 4 });
    expect(noteNodeSpec('artifact')!.editableAfter).toBe(false); // opaque fallback
    expect(noteNodeSpec('nope')).toBeUndefined();
  });
  it('AI-creatable + editable sets are consistent (editable-native is the default; artifact/image are the opaque exceptions)', () => {
    expect(aiCreatableNodes()).toContain('paragraph');
    expect(aiCreatableNodes()).toContain('excalidrawBoard');
    expect(editableNodes()).not.toContain('artifact');
    expect(editableNodes()).not.toContain('image');
  });
});
