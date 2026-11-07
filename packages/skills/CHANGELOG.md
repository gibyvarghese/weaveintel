# @weaveintel/skills

## 0.2.0

### Added

- **Tenant- and team-scoped overlays** (`scoped-overlays.ts`): `ScopedSkillOverlay` (a `SkillExtensionOverlay`
  with `tenantId` / `teamId`), `resolveScopedSkill(skill, overlays, scope)` applying vendor → tenant → team
  for the call's own tenant and team only, `withScopedOverlay` and `tightenSkillPolicy`. Tightening is strict:
  `allowedTools` is intersected (an overlay can never grant a tool the vendor skill lacked), the budget only
  shortens, approval only switches on, side effects only switch off, and an org or team can switch a skill
  off for itself but never back on past a vendor "off".
- **The skill store port**: `SkillStore` and `InMemorySkillStore` (vendor definitions, scoped overlays, eval
  records with `latestEval` at the most specific scope).
- `SkillDefinition.modelTier`, `contextRecipeId`, `evalSuiteId`.
- `activateSkills` options `scopedOverlays`, `scope` and `evaluationOf`.

### Changed

- `activateSkills` no longer offers a skill in `draft` lifecycle, nor one whose latest evaluation failed
  (`isSkillActivatable`).
