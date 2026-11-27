---
'@weaveintel/tools-browser': minor
---

New subpath `@weaveintel/tools-browser/steps` for doing in a browser what no API can, from steps written as data. `runSteps` carries out `goto`, `fill`, `choose`, `pick` (typeahead), `check`, `click`, `expect` and `read` steps, plus `fillForm`, which turns a person's answered questions into steps by kind. Fields are found by their visible label, buttons by name and options by text, so connector packs name no selectors. Every run is held to allowlisted hosts (checked after each click too) and a step limit. It never types a credential-shaped value and logs each step for evidence. `playwrightDriver(page)` finds fields by accessible label and handles typeahead controls that hide their input behind an off-screen focusser.
