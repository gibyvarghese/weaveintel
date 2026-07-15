# Changesets

This folder drives **independent** SemVer versioning + changelogs for the published `@weaveintel/*` packages.
See [`../VERSIONING.md`](../VERSIONING.md) for the two-track scheme (libraries here; the geneWeave product versions
separately).

## Recording a change (in your PR)

```bash
npx changeset          # pick the package(s) you changed + a bump type
```

- **`patch`** — bug fix, no API change · **`minor`** — backward-compatible feature · **`major`** — breaking change.
- Commit the generated `.changeset/*.md`. **No changeset ⇒ that package will not be released.**
- Only published packages are selectable; `@weaveintel/live-agents-demo` is `"ignore"`d (a demo app, not on npm).

## Releasing (automated — nothing to run by hand)

On push to `main`, the [Release workflow](../.github/workflows/release.yml) runs the
[Changesets action](https://github.com/changesets/action):

1. If changesets are pending, it opens/updates a **"Version Packages"** PR that runs `npm run ci:version`
   (`changeset version`) — bumping versions + writing `CHANGELOG.md`s.
2. Merging that PR runs `npm run ci:publish` — a small guard (`scripts/ci-publish.mjs`) that publishes
   only the packages whose version isn't yet on npm (delegating to `changeset publish`), so an ordinary
   push with nothing to release is a clean no-op instead of erroring on already-published versions.

Publishing uses **npm Trusted Publishing (OIDC)** — no `NPM_TOKEN`; npm mints a short-lived token from the
workflow's identity and attaches a **provenance** attestation (`NPM_CONFIG_PROVENANCE`). One-time owner setup on
npmjs.com (linking the repo/workflow as a trusted publisher) is documented in the workflow header.
