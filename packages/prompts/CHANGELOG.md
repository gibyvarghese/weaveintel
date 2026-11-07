# @weaveintel/prompts

## 0.2.0

### Added

- **Layered frameworks** (`layered.ts`): a prompt held as ordered sections, each with a lock class —
  `locked` (vendor only), `append` (vendor, then org, then team, each under its own heading), `replace`
  (most specific non-empty layer wins) and `runtime` (filled from `{{slot}}` values by code).
  `mergeFrameworkLayers(framework, overlays, { slots, omit, strict })` merges by section key and renders;
  with no overlays the output is the vendor text byte for byte, so a host can prove parity before deleting
  a code constant. Overlays on locked or runtime sections are ignored and reported by `lintLayers`
  (`LOCKED_SECTION_OVERLAY`, `RUNTIME_SECTION_OVERLAY`); overlay text is never slot-expanded. Every render
  carries a sha256 `hash` and the overlay `versionRefs` for the trace.
- **The prompt store port** (`prompt-store.ts`): `PromptStore` (frameworks, active overlays per
  tenant/team scope, draft versions, evaluations, activation, rejection, history), `InMemoryPromptStore`,
  `renderFromStore`, `assertWritable` and `definePromptStoreContract` — the contract suite a host adapter
  runs. A version is a draft until an evaluation that passed is recorded; activating retires the version it
  replaces; a retired version that passed may be activated again (rollback).
