# @weaveintel/guardrails

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
