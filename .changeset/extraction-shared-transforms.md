---
"@weaveintel/extraction": minor
---

Mapping proposals speak the shared transform vocabulary. `toMappingRule(transform, field?, samples?)` converts a
proposal transform (`upper`, `date_dmy`, `number_comma_decimal`, `enum_match`, …) to the one closed list shared by
`@weaveintel/connect` and `@schemaweave/inbound` (`uppercase`; `date` with `day_first`; `number` with
`comma_decimal`; `choice_map`). `applyTransform` now reads values with connect's shared readers, so a preview matches
the saved mapping. **Behaviour changes**: `x` is no longer read as yes; `t`/`f`, `on`/`off`, `checked`/`unchecked`
are; a two-digit year uses the 1969–2068 window (was always 20xx); numbers read currency signs and accounting brackets.
