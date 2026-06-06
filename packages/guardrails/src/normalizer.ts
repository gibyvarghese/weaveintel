/**
 * @weaveintel/guardrails -- normalizer.ts  (W10)
 *
 * Input normalisation pre-pass applied before blocklist/regex matching so
 * that trivially obfuscated inputs are still caught by deterministic guardrails.
 *
 * Operations (applied in order):
 *   1. NFKC normalisation -- collapses full-width chars, ligatures, etc.
 *   2. Zero-width stripping -- removes invisible codepoints.
 *   3. Homoglyph folding -- maps Cyrillic/Greek confusables to ASCII.
 *   4. Encoding probe -- flags likely base64 or URL-encoded payloads
 *      WITHOUT silently decoding them.
 */

export interface NormalizeOptions {
  readonly nfkc?: boolean;
  readonly stripZeroWidth?: boolean;
  readonly foldHomoglyphs?: boolean;
  readonly detectEncoding?: boolean;
}

export interface NormalizeResult {
  readonly text: string;
  readonly changed: boolean;
  readonly flags: {
    readonly likelyBase64?: boolean;
    readonly likelyUrlEncoded?: boolean;
  };
}

// Build the zero-width character set from explicit Unicode escapes so the
// source file contains no invisible characters that could confuse tooling.
const ZW = [
  '​', // ZERO WIDTH SPACE
  '‌', // ZERO WIDTH NON-JOINER
  '‍', // ZERO WIDTH JOINER
  '‎', // LEFT-TO-RIGHT MARK
  '‏', // RIGHT-TO-LEFT MARK
  ' ', // NO-BREAK SPACE
  '­', // SOFT HYPHEN
  '﻿', // BOM / ZERO WIDTH NO-BREAK SPACE
  ' ', // LINE SEPARATOR
  ' ', // PARAGRAPH SEPARATOR
  '‪', // LEFT-TO-RIGHT EMBEDDING
  '‫', // RIGHT-TO-LEFT EMBEDDING
  '‬', // POP DIRECTIONAL FORMATTING
  '‭', // LEFT-TO-RIGHT OVERRIDE
  '‮', // RIGHT-TO-LEFT OVERRIDE
  '⁠', // WORD JOINER
  '⁡', // FUNCTION APPLICATION (invisible)
  '⁢', // INVISIBLE TIMES
  '⁣', // INVISIBLE SEPARATOR
  '⁤', // INVISIBLE PLUS
].join('');

const ZERO_WIDTH_RE = new RegExp(`[${ZW}]`, 'g');

// Homoglyph map: confusable -> ASCII.
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  // Cyrillic lookalikes
  'а': 'a', // a
  'е': 'e', // e
  'о': 'o', // o
  'р': 'p', // r
  'с': 'c', // s
  'х': 'x', // x
  'А': 'A', // A
  'В': 'B', // B
  'Е': 'E', // E
  'К': 'K', // K
  'М': 'M', // M
  'Н': 'H', // N
  'О': 'O', // O
  'Р': 'P', // R
  'С': 'C', // S
  'Т': 'T', // T
  'Х': 'X', // X
  'У': 'Y', // U
  // Greek lookalikes
  'α': 'a', // alpha
  'β': 'b', // beta
  'ε': 'e', // epsilon
  'η': 'n', // eta
  'ι': 'i', // iota
  'κ': 'k', // kappa
  'ν': 'v', // nu
  'ο': 'o', // omicron
  'ρ': 'p', // rho
  'τ': 't', // tau
  'υ': 'u', // upsilon
  'χ': 'x', // chi
  'Α': 'A', // Alpha
  'Β': 'B', // Beta
  'Ε': 'E', // Epsilon
  'Η': 'H', // Eta
  'Ι': 'I', // Iota
  'Κ': 'K', // Kappa
  'Μ': 'M', // Mu
  'Ν': 'N', // Nu
  'Ο': 'O', // Omicron
  'Ρ': 'P', // Rho
  'Τ': 'T', // Tau
  'Υ': 'Y', // Upsilon
  'Χ': 'X', // Chi
  // Curly quotes -> straight
  '‘': "'", '’': "'", '“': '"', '”': '"',
  // Dashes -> hyphen
  '–': '-', '—': '-', '―': '-',
  // Bullets/dots -> period
  '·': '.', '•': '.', '‧': '.',
  // Superscript digits
  '¹': '1', '²': '2', '³': '3',
};

const HOMOGLYPH_CHARS = Object.keys(HOMOGLYPHS).join('');
const HOMOGLYPH_RE = new RegExp(`[${HOMOGLYPH_CHARS}]`, 'g');

const BASE64_RE = /(?:[A-Za-z0-9+/]{20,}={0,2})/;
const URL_ENC_RE = /(%[0-9A-Fa-f]{2}){3,}/;

export function normalizeInput(text: string, opts: NormalizeOptions = {}): NormalizeResult {
  const { nfkc = true, stripZeroWidth = true, foldHomoglyphs = true, detectEncoding = true } = opts;

  let result = text;

  if (nfkc) result = result.normalize('NFKC');
  if (stripZeroWidth) result = result.replace(ZERO_WIDTH_RE, '');
  if (foldHomoglyphs) result = result.replace(HOMOGLYPH_RE, (ch) => HOMOGLYPHS[ch] ?? ch);

  const likelyBase64 = detectEncoding ? BASE64_RE.test(result) : false;
  const likelyUrlEncoded = detectEncoding ? URL_ENC_RE.test(result) : false;
  const flags: NormalizeResult['flags'] = {
    ...(likelyBase64 ? { likelyBase64: true } : {}),
    ...(likelyUrlEncoded ? { likelyUrlEncoded: true } : {}),
  };

  return { text: result, changed: result !== text, flags };
}
