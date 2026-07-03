# @weaveintel/i18n

Framework-agnostic **internationalisation core** for weaveIntel UIs — pure, dependency-free, and the same on the server, web app, desktop and mobile.

## Why this exists

A UI with hardcoded English strings can't be shown in another language. i18n replaces each visible string with a **key** looked up in a per-locale **message catalog**, with interpolation, plurals, and a fallback chain so a partially-translated locale still works. This package is the pure core of that (no DOM, no I/O), so it's trivially testable and reusable everywhere.

## What's in the box

| Primitive | What it does |
|---|---|
| `createTranslator({ messages, locale, fallbackLocale })` → `t(key, params)` | Look a **key** up in the catalog for `locale`, walking a **BCP-47 fallback chain** (`es-MX` → `es` → `en`), and interpolate. A missing key returns the key itself (graceful degradation, never blank). |
| `interpolate(template, params, locale)` | The **ICU-subset** message formatter: named args `Hello {name}`, plurals `{n, plural, =0 {no notes} one {# note} other {# notes}}` (CLDR categories via `Intl.PluralRules`, exact `=N` cases, `#` = the count). **Parameters are inserted as literal text and never re-scanned** — a value containing `{other}` or an ICU fragment can't inject formatting (no template injection). |
| `resolveLocaleChain(locale, fallback)` | The BCP-47 fallback list (`es-MX` → `es` → `en`, deduped, always ending in the fallback). |
| `pluralCategory(n, locale)` | The CLDR plural category (`one`/`other`/…) for a number in a locale. |

```ts
import { createTranslator } from '@weaveintel/i18n';

const t = createTranslator({
  messages: { en: { notes: '{n, plural, one {# note} other {# notes}}' }, es: { notes: '{n, plural, one {# nota} other {# notas}}' } },
  locale: 'es', fallbackLocale: 'en',
});
t.t('notes', { n: 3 }); // "3 notas"
```

## In geneWeave

geneWeave ships a base `en` catalog + additional locales, and **AI-assisted locale packs**: an admin asks the assistant to translate the app to a new language (reusing the notes `translate.ts` faithful-translation + placeholder-protection engine), stored per-tenant. The raw-served web UI mirrors this pure `t()` (it can't bare-import a workspace package); the tests here are the spec. A bundled app (desktop/mobile) depends on this package directly.

## Status

Shipped with geneWeave Round 9 (internationalisation). Pure + zero-dependency; positive / negative / stress / security unit tests in `i18n.test.ts`.
