# @weaveintel/guardrails

## 0.2.1

### Added

- **Guards for text that came out of a file** (`file-content.ts`):
  - `stripHiddenText`: removes zero-width, bidi, invisible-filler, soft-hyphen and control characters and Unicode
    tag characters, and reports each kind; tag characters are decoded so the hidden ASCII is visible to a reviewer.
  - `compareTextLayers`: a PDF text layer against OCR of the rendered page; a run of words only in the text layer
    (white text, text under an image, tiny fonts) is flagged as a `text_layer_only` finding.
  - `fileSpotlight`: a random per-call fence (`crypto.getRandomValues`) with a file-specific boundary sentence;
    forged boundaries are removed from the content and labels are sanitised (neutral labels only).
  - `InjectionSignal` port (a signal, not a gate), a deterministic `createHeuristicInjectionSignal`, and
    `combineInjectionSignals` (highest score, every hit, a failing engine is reported rather than thrown).

## 0.2.0

### Added

- Tool-result quarantine (GAPS G-WI-2, platform-architecture §7.4 item 10): `quarantineToolResult()`
  fences a result in the run's spotlight fence and withholds one that does not match the tool's
  declared `returns` schema; `validateJsonSchema()` is a dependency-free JSON Schema subset. Subpath
  `@weaveintel/guardrails/tool-quarantine`.
- New Zealand redaction built-ins (G-WI-13, §7.4 item 6): `nz_ird` (check digit and range verified),
  `nz_mobile`, `nz_nhi` (check digit verified for AAANNNC), `nz_passport`; `NZ_PII_PATTERNS`,
  `isValidNzIrd`, `isValidNzNhi`. A built-in can carry a validator, so numbers that fail their check
  digit are left alone.
- `GUARDRAILS_2026` gains "Compliance: NZ PII Redaction" (disabled by default, like the other residency
  rows).
