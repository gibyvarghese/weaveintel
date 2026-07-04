// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  CURSOR_COLORS, peerColor, AI_PARTICIPANT, aiPeerId, isAiPeerId, aiAwarenessState, sanitizeAwarenessState,
} from './presence-helpers.js';

describe('presence-helpers — peer colours', () => {
  it('is deterministic + stable for the same key', () => {
    expect(peerColor('u:alice')).toBe(peerColor('u:alice'));
    expect(CURSOR_COLORS).toContain(peerColor('u:alice'));
  });
  it('never hands a human the AI-reserved emerald', () => {
    expect(CURSOR_COLORS).not.toContain('#0E9A6E');
    for (let i = 0; i < 2000; i++) expect(peerColor(`u:user-${i}`)).not.toBe('#0E9A6E');
  });
  it('spreads keys across the whole palette', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(peerColor(`u:p${i}`));
    expect(seen.size).toBe(CURSOR_COLORS.length); // every colour gets used
  });
});

describe('presence-helpers — the AI participant', () => {
  it('has the agency emerald + a stable per-note id', () => {
    expect(AI_PARTICIPANT.color).toBe('#0E9A6E');
    expect(AI_PARTICIPANT.peerType).toBe('ai');
    expect(aiPeerId('note-7')).toBe('ai:note-7');
    expect(isAiPeerId('ai:note-7')).toBe(true);
    expect(isAiPeerId('u:alice:ab12')).toBe(false);
  });
  it('builds a live AI awareness state', () => {
    const s = aiAwarenessState('composing');
    expect(s).toMatchObject({ name: 'weaveIntel AI', color: '#0E9A6E', status: 'composing', peerType: 'ai' });
  });
});

describe('presence-helpers — sanitizeAwarenessState (security gate)', () => {
  it('passes a normal frame through, bounded', () => {
    const s = sanitizeAwarenessState({ name: 'Alice', color: '#3B6FB0', status: 'editing', peerType: 'human', cursor: { anchor: 4, head: 11 } });
    expect(s).toMatchObject({ name: 'Alice', color: '#3B6FB0', status: 'editing', peerType: 'human' });
    expect((s as { cursor?: { anchor: number; head: number } }).cursor).toEqual({ anchor: 4, head: 11 });
  });
  it('treats null/undefined as "went offline"', () => {
    expect(sanitizeAwarenessState(null)).toBeNull();
    expect(sanitizeAwarenessState(undefined)).toBeNull();
    expect(sanitizeAwarenessState('nonsense')).toBeNull();
    expect(sanitizeAwarenessState(42)).toBeNull();
  });
  it('caps a giant name + status (anti-flood)', () => {
    const s = sanitizeAwarenessState({ name: 'A'.repeat(5000), status: 'x'.repeat(500) })!;
    expect(s.name!.length).toBe(64);
    expect(s.status!.length).toBe(32);
  });
  it('drops a script-laden / url() colour (no CSS injection)', () => {
    expect(sanitizeAwarenessState({ color: 'url(javascript:alert(1))' })!.color).toBeUndefined();
    expect(sanitizeAwarenessState({ color: 'red;}body{display:none}' })!.color).toBeUndefined();
    expect(sanitizeAwarenessState({ color: '#FAC775' })!.color).toBe('#FAC775');
    expect(sanitizeAwarenessState({ color: 'coral' })!.color).toBe('coral');
  });
  it('coerces an absurd / non-numeric cursor away', () => {
    expect((sanitizeAwarenessState({ cursor: { anchor: -5, head: 1e12 } }) as { cursor?: unknown }).cursor).toBeUndefined();
    expect((sanitizeAwarenessState({ cursor: { anchor: 'DROP TABLE', head: {} } }) as { cursor?: unknown }).cursor).toBeUndefined();
    expect((sanitizeAwarenessState({ cursor: { head: 12 } }) as { cursor?: { head: number } }).cursor).toEqual({ head: 12 });
  });
  it('drops unknown keys (no arbitrary data through presence)', () => {
    const s = sanitizeAwarenessState({ name: 'A', evil: { huge: 'x'.repeat(99999) }, __proto__: { polluted: true } }) as Record<string, unknown>;
    expect(s['evil']).toBeUndefined();
    expect(s['polluted']).toBeUndefined();
  });
  it('STRESS: 1000 hostile frames never throw + never leak a brace/url', () => {
    for (let i = 0; i < 1000; i++) {
      const s = sanitizeAwarenessState({ name: `n${i};}`, color: `#${i.toString(16)};}`, status: `s${i}`, cursor: { anchor: i, head: i * 7 } });
      if (s?.color) { expect(s.color).not.toMatch(/[;{}]/); expect(s.color).not.toContain('url('); }
    }
  });
});
