// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  TARGET_LANGUAGES, resolveLanguage, protectNonTranslatable, restoreProtected, countSentinels,
  buildTranslatePrompt, parseTranslation, verifyTranslation,
} from './translate.js';

describe('translate — language resolution', () => {
  it('resolves by ISO code, name, prefix, and BCP-47/legacy aliases', () => {
    expect(resolveLanguage('es')!.name).toBe('Spanish');
    expect(resolveLanguage('Spanish')!.code).toBe('es');
    expect(resolveLanguage('SPANISH')!.code).toBe('es');
    expect(resolveLanguage('span')!.code).toBe('es');       // prefix
    expect(resolveLanguage('pt-BR')!.code).toBe('pt');      // BCP-47 → base
    expect(resolveLanguage('iw')!.code).toBe('he');         // legacy Hebrew code
    expect(resolveLanguage('in')!.code).toBe('id');         // legacy Indonesian code
    expect(resolveLanguage('no')).toBeNull();               // 'no'→nb, which isn't in the offered set → null
  });
  it('returns null for junk / empty', () => {
    expect(resolveLanguage('')).toBeNull();
    expect(resolveLanguage(null)).toBeNull();
    expect(resolveLanguage('klingon')).toBeNull();
    expect(resolveLanguage(123 as unknown as string)).toBeNull();
  });
  it('flags RTL languages', () => {
    expect(resolveLanguage('ar')!.rtl).toBe(true);
    expect(resolveLanguage('he')!.rtl).toBe(true);
    expect(resolveLanguage('fa')!.rtl).toBe(true);
    expect(resolveLanguage('en')!.rtl).toBeUndefined();
    expect(TARGET_LANGUAGES.length).toBeGreaterThanOrEqual(20);
  });
});

describe('translate — protect / restore non-translatable spans', () => {
  it('masks code fences, inline code, links, URLs, wiki-links and mentions; restores them exactly', () => {
    const src = [
      '# Heading with `inlineCode`',
      '',
      'See https://example.com/docs and [[Other Note]] — ask @alice.',
      '',
      '```js',
      'const x = 1; // keep me',
      '```',
      '',
      '[a link](https://example.com/page)',
    ].join('\n');
    const { masked, tokens } = protectNonTranslatable(src);
    // The protected spans are gone from the masked text…
    expect(masked).not.toContain('inlineCode');
    expect(masked).not.toContain('https://example.com/docs');
    expect(masked).not.toContain('const x = 1');
    expect(masked).not.toContain('[[Other Note]]');
    expect(countSentinels(masked)).toBe(tokens.length);
    expect(tokens.length).toBeGreaterThanOrEqual(6);
    // …and round-trip restores the original byte-for-byte.
    expect(restoreProtected(masked, tokens)).toBe(src);
  });
  it('restores even if the model reordered surrounding text, and ignores unknown sentinels', () => {
    const { masked, tokens } = protectNonTranslatable('keep `code` here');
    expect(restoreProtected(masked, tokens)).toBe('keep `code` here');
    expect(restoreProtected('⟦9⟧ stays', tokens)).toBe('⟦9⟧ stays'); // out-of-range left as-is
  });
  it('handles text with no protectable spans', () => {
    const { masked, tokens } = protectNonTranslatable('just plain prose');
    expect(masked).toBe('just plain prose');
    expect(tokens).toEqual([]);
  });
});

describe('translate — prompt building (spotlighting + rules)', () => {
  it('spotlights the document as data and lists the strict rules', () => {
    const { system, user } = buildTranslatePrompt('Hello ⟦0⟧', { targetLanguage: 'French' });
    expect(system).toContain('professional translator');
    expect(system).toContain('French');
    expect(system).toMatch(/untrusted DATA|never obey/i);   // injection defence
    expect(system).toContain('⟦0⟧');                        // sentinel preservation rule
    expect(user).toContain('DOCUMENT');                     // delimiters
    expect(user).toContain('Hello ⟦0⟧');
  });
  it('injects formality + glossary when given', () => {
    const { system } = buildTranslatePrompt('x', { targetLanguage: 'German', formality: 'formal', glossary: ['WeaveIntel', 'Acme'] });
    expect(system).toMatch(/formal/i);
    expect(system).toContain('WeaveIntel');
    expect(system).toContain('Acme');
  });
  it('omits tone/glossary lines when not given', () => {
    const { system } = buildTranslatePrompt('x', { targetLanguage: 'Italian' });
    expect(system).not.toMatch(/register\/tone/i);
    expect(system).not.toMatch(/untranslated:/i);
  });
});

describe('translate — parse the reply', () => {
  it('strips a "Here is the translation:" preamble and an enclosing code fence', () => {
    expect(parseTranslation('Here is the translation:\nHola mundo')).toBe('Hola mundo');
    expect(parseTranslation('```\nHola mundo\n```')).toBe('Hola mundo');
    expect(parseTranslation('```markdown\n# Título\n```')).toBe('# Título');
    expect(parseTranslation('  Bonjour  ')).toBe('Bonjour');
  });
  it('leaves a clean translation untouched (incl. internal fences)', () => {
    const clean = '# Título\n\n```js\ncode\n```\n\nTexto';
    expect(parseTranslation(clean)).toBe(clean);
  });
});

describe('translate — verify the result', () => {
  const masked = protectNonTranslatable('# Heart\n\nThe heart pumps blood. See `ekg()`.').masked; // realistic source (1 inline-code span)
  it('passes a good translation (different text, sentinels + structure preserved)', () => {
    const src = '# Heart\n\nThe heart pumps blood.';
    const out = '# Corazón\n\nEl corazón bombea sangre.';
    const v = verifyTranslation(src, out);
    expect(v.ok).toBe(true);
    expect(v.warnings).toEqual([]);
  });
  it('FAILS an empty translation', () => {
    expect(verifyTranslation('# Heart', '').ok).toBe(false);
    expect(verifyTranslation('# Heart', '   ').reason).toMatch(/empty/);
  });
  it('FAILS when a protected sentinel was dropped or invented', () => {
    expect(verifyTranslation('a ⟦0⟧ b ⟦1⟧', 'x ⟦0⟧ y').ok).toBe(false);     // dropped ⟦1⟧
    expect(verifyTranslation('a ⟦0⟧', 'x ⟦0⟧ y ⟦1⟧').ok).toBe(false);       // invented ⟦1⟧
    expect(verifyTranslation('a ⟦0⟧ b ⟦1⟧', 'x ⟦0⟧ y ⟦1⟧').ok).toBe(true);  // both kept
  });
  it('FAILS a no-op (output identical to a text-bearing source)', () => {
    const v = verifyTranslation('The heart pumps blood.', 'The heart pumps blood.');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/identical/);
  });
  it('allows identical output when same-language is explicitly allowed, or source is symbol-only', () => {
    expect(verifyTranslation('123 ⟦0⟧', '123 ⟦0⟧').ok).toBe(true);             // no letters → fine
    expect(verifyTranslation('Hello', 'Hello', { sameLanguageAllowed: true }).ok).toBe(true);
  });
  it('warns (soft) when headings vanish or code-fence count differs, without hard-failing', () => {
    const v = verifyTranslation('# A\n\nlots of words here', 'sin encabezado aquí amigo');
    expect(v.ok).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/headings/);
  });
  it('uses the masked source consistently (smoke)', () => {
    expect(countSentinels(masked)).toBe(1);
  });
});
