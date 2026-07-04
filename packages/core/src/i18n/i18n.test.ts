/**
 * Tests — i18n core (i18n.ts). Positive / negative / stress / security.
 */
import { describe, it, expect } from 'vitest';
import { resolveLocaleChain, pluralCategory, interpolate, createTranslator, type LocaleMessages } from './i18n.js';

describe('resolveLocaleChain — BCP-47 fallback', () => {
  it('POSITIVE — region → language → fallback', () => {
    expect(resolveLocaleChain('es-MX', 'en')).toEqual(['es-MX', 'es', 'en']);
  });
  it('a bare language keeps just itself + fallback', () => {
    expect(resolveLocaleChain('fr', 'en')).toEqual(['fr', 'en']);
  });
  it('the fallback itself does not duplicate', () => {
    expect(resolveLocaleChain('en', 'en')).toEqual(['en']);
    expect(resolveLocaleChain('en-GB', 'en')).toEqual(['en-GB', 'en']);
  });
  it('NEGATIVE — empty/garbage locale → just the fallback', () => {
    expect(resolveLocaleChain('', 'en')).toEqual(['en']);
    expect(resolveLocaleChain('   ', 'en')).toEqual(['en']);
  });
});

describe('interpolate — named args', () => {
  it('POSITIVE — replaces {name}', () => {
    expect(interpolate('Hello {name}!', { name: 'Ada' })).toBe('Hello Ada!');
  });
  it('a missing param keeps the literal placeholder (dev-visible)', () => {
    expect(interpolate('Hi {name}', {})).toBe('Hi {name}');
  });
  it('multiple + repeated params', () => {
    expect(interpolate('{a} + {a} = {b}', { a: 2, b: 4 })).toBe('2 + 2 = 4');
  });
});

describe('interpolate — plurals (ICU subset)', () => {
  const tpl = '{n, plural, =0 {no notes} one {# note} other {# notes}}';
  it('exact =0 wins', () => { expect(interpolate(tpl, { n: 0 })).toBe('no notes'); });
  it('one', () => { expect(interpolate(tpl, { n: 1 })).toBe('1 note'); });
  it('other + # substitution', () => { expect(interpolate(tpl, { n: 5 })).toBe('5 notes'); });
  it('mixes plural with named args', () => {
    expect(interpolate('{who} has {n, plural, one {# note} other {# notes}}', { who: 'Ada', n: 2 })).toBe('Ada has 2 notes');
  });
  it('falls back to other when a category is absent', () => {
    expect(interpolate('{n, plural, other {# items}}', { n: 1 })).toBe('1 items');
  });
});

describe('pluralCategory', () => {
  it('English one vs other', () => {
    expect(pluralCategory(1, 'en')).toBe('one');
    expect(pluralCategory(2, 'en')).toBe('other');
    expect(pluralCategory(0, 'en')).toBe('other');
  });
});

describe('createTranslator', () => {
  const messages: LocaleMessages = {
    en: { hello: 'Hello', greet: 'Hi {name}', notes: '{n, plural, one {# note} other {# notes}}' },
    es: { hello: 'Hola', greet: 'Hola {name}' }, // note: 'notes' intentionally missing in es
  };
  it('POSITIVE — translates in the active locale', () => {
    const t = createTranslator({ messages, locale: 'es' });
    expect(t.t('hello')).toBe('Hola');
    expect(t.t('greet', { name: 'Ada' })).toBe('Hola Ada');
  });
  it('falls back to the base locale for a missing key (partial translation still works)', () => {
    const t = createTranslator({ messages, locale: 'es', fallbackLocale: 'en' });
    expect(t.t('notes', { n: 3 })).toBe('3 notes'); // from en
  });
  it('region locale falls through to language then base', () => {
    const t = createTranslator({ messages, locale: 'es-MX', fallbackLocale: 'en' });
    expect(t.t('hello')).toBe('Hola');
  });
  it('NEGATIVE — an unknown key returns the key itself (graceful)', () => {
    const t = createTranslator({ messages, locale: 'en' });
    expect(t.t('does.not.exist')).toBe('does.not.exist');
    expect(t.has('does.not.exist')).toBe(false);
    expect(t.has('hello')).toBe(true);
  });
});

describe('SECURITY / robustness', () => {
  it('a param value containing ICU/placeholder syntax is inserted LITERALLY (no re-injection)', () => {
    expect(interpolate('You said: {msg}', { msg: '{n, plural, other {hacked}} {other}' })).toBe('You said: {n, plural, other {hacked}} {other}');
  });
  it('a non-string template never throws', () => {
    expect(interpolate(undefined as unknown, { x: 1 })).toBe('');
    expect(interpolate(12345 as unknown, {})).toBe('12345');
  });
  it('an unterminated brace is left as-is (no crash)', () => {
    expect(interpolate('a {b', { b: 1 })).toBe('a {b');
  });
  it('STRESS — a 50k-char template with many placeholders resolves fast', () => {
    const tpl = 'x{a} '.repeat(10_000);
    const t = Date.now();
    const out = interpolate(tpl, { a: 'Z' });
    expect(Date.now() - t).toBeLessThan(300);
    expect(out.startsWith('xZ xZ')).toBe(true);
  });
});
