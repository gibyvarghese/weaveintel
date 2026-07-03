# Changesets

This folder manages versioning + changelogs for the published `@weaveintel/*` library.

- The library was first published at **`0.0.1`**. Apps (`geneweave-api`, `geneweave-ui`, `desktop`, `mobile`,
  `live-agents-demo`) are **ignored** — they aren't published to npm.
- To record a change: `npx changeset` (pick packages + bump type). To release: `npx changeset version` then
  `npx changeset publish` (uses `publishConfig.access: public`).
