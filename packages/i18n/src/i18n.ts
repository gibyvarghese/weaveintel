/**
 * @weaveintel/i18n — the pure, framework-free internationalisation core.
 *
 * A UI with hardcoded English strings can't be shown in another language. i18n replaces each visible string
 * with a KEY that's looked up in a message CATALOG for the reader's locale — with interpolation ("Hello
 * {name}"), plurals ("{n, plural, one {# note} other {# notes}}"), and a fallback chain (es-MX → es → en) so
 * a partially-translated locale still works. This module is that core: pure (no DOM, no I/O), so it's the
 * same on the server, the web app, desktop and mobile, and it's exhaustively testable.
 *
 * Research grounding: ICU MessageFormat is the industry standard for interpolation + plurals (this implements
 * the common subset — named args, `plural` with `=N` exact cases + CLDR categories, and `#` = the count).
 * Locale fallback follows BCP-47 truncation. Plural categories use `Intl.PluralRules` when available.
 *
 * SECURITY: parameters are substituted as literal TEXT and are never re-scanned, so a value containing
 * "{other}" or an ICU fragment can't inject formatting or reach another placeholder.
 */

export type Messages = Record<string, string>;
export type LocaleMessages = Record<string, Messages>;

/** BCP-47 fallback chain: "es-MX" → ["es-MX","es","en"]. Deduped; always ends with `fallback`. */
export function resolveLocaleChain(locale: string, fallback = 'en'): string[] {
  const chain: string[] = [];
  const push = (l: string) => { const v = (l || '').trim(); if (v && !chain.includes(v)) chain.push(v); };
  let cur = (locale || '').trim();
  while (cur) { push(cur); const cut = cur.lastIndexOf('-'); cur = cut > 0 ? cur.slice(0, cut) : ''; }
  push(fallback);
  return chain;
}

/** The CLDR plural category for `n` in `locale` (Intl.PluralRules when available; else a simple en-style rule). */
export function pluralCategory(n: number, locale = 'en'): Intl.LDMLPluralRule {
  const num = typeof n === 'number' && Number.isFinite(n) ? Math.abs(n) : 0;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.PluralRules === 'function') {
      return new Intl.PluralRules(locale).select(num);
    }
  } catch { /* fall through */ }
  return num === 1 ? 'one' : 'other';
}

// ── ICU-subset interpolation ─────────────────────────────────────────────────────────────

/** Find the matching close brace for the `{` at `open`; returns its index or -1. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

interface PluralBlock { varName: string; cases: Array<{ key: string; body: string }>; end: number }

/** Try to parse `{ident, plural, key {body} ...}` starting at `open` (index of the `{`). */
function parsePlural(s: string, open: number): PluralBlock | null {
  const close = matchBrace(s, open);
  if (close < 0) return null;
  const inner = s.slice(open + 1, close);
  const m = /^\s*([A-Za-z0-9_]+)\s*,\s*plural\s*,\s*/.exec(inner);
  if (!m) return null;
  let rest = inner.slice(m[0].length);
  const cases: Array<{ key: string; body: string }> = [];
  // Parse a sequence of `key {body}` entries (relative to `rest`).
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i]!)) i++;
    if (i >= rest.length) break;
    const km = /^(=\d+|zero|one|two|few|many|other)/.exec(rest.slice(i));
    if (!km) break;
    i += km[0].length;
    while (i < rest.length && /\s/.test(rest[i]!)) i++;
    if (rest[i] !== '{') break;
    const bClose = matchBrace(rest, i);
    if (bClose < 0) break;
    cases.push({ key: km[0], body: rest.slice(i + 1, bClose) });
    i = bClose + 1;
  }
  if (!cases.length) return null;
  return { varName: m[1]!, cases, end: close + 1 };
}

/** Replace `{name}` occurrences (missing params keep the literal placeholder — dev-visible). */
function fillNamed(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole;
  });
}

/**
 * Interpolate an ICU-subset template with `params`. Handles named args `{x}`, `#` (the active count), and
 * `{count, plural, =0 {…} one {…} other {…}}`. Non-string template → coerced to string; never throws.
 */
export function interpolate(template: unknown, params: Record<string, unknown> = {}, locale = 'en'): string {
  const src = typeof template === 'string' ? template : String(template ?? '');
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '{') {
      const block = parsePlural(src, i);
      if (block) {
        const raw = params[block.varName];
        const n = typeof raw === 'number' ? raw : Number(raw);
        const exact = block.cases.find((c) => c.key === `=${n}`);
        const cat = pluralCategory(Number.isFinite(n) ? n : 0, locale);
        const chosen = exact ?? block.cases.find((c) => c.key === cat) ?? block.cases.find((c) => c.key === 'other') ?? block.cases[0]!;
        // `#` in the chosen body is the count; then fill any named params in the body.
        out += fillNamed(chosen.body.replace(/#/g, Number.isFinite(n) ? String(n) : ''), params);
        i = block.end;
        continue;
      }
    }
    out += src[i++];
  }
  return fillNamed(out, params);
}

// ── Translator ───────────────────────────────────────────────────────────────────────────

export interface Translator {
  locale: string;
  /** Translate a key with optional params. Missing key → returns the key itself (graceful degradation). */
  t(key: string, params?: Record<string, unknown>): string;
  /** Is there a message for this key anywhere in the fallback chain? */
  has(key: string): boolean;
}

/** Build a translator for a locale over a set of per-locale catalogs, with BCP-47 fallback. */
export function createTranslator(opts: { messages: LocaleMessages; locale: string; fallbackLocale?: string }): Translator {
  const chain = resolveLocaleChain(opts.locale, opts.fallbackLocale ?? 'en');
  const lookup = (key: string): string | undefined => {
    for (const loc of chain) {
      const m = opts.messages[loc];
      if (m && Object.prototype.hasOwnProperty.call(m, key) && typeof m[key] === 'string') return m[key];
    }
    return undefined;
  };
  return {
    locale: opts.locale,
    has: (key) => lookup(key) !== undefined,
    t: (key, params) => {
      const tpl = lookup(key);
      if (tpl == null) return key; // graceful: show the key rather than blank
      return interpolate(tpl, params ?? {}, opts.locale);
    },
  };
}
