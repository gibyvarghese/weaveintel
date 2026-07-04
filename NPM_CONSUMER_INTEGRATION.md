# Standalone npm-consumer integration

This is the safety net that lets the geneWeave community app **live on its own** (or move to its own
repo) without losing the coverage the monorepo gives it today.

## Why

The in-repo `Test` workflow builds the app against the **local `packages/*`** (workspace symlinks). That
proves the app works against *source in this repo* — but it does **not** prove the app works against the
**published** `@weaveintel/*` packages the way a real adopter (or the private commercial repo) consumes
them. Those are different resolution paths, and only the second one matches how the library actually
ships. If the community app ever moves out of this monorepo, the workspace test disappears entirely.

This integration check closes that gap.

## The pieces

| File | What it does |
|---|---|
| `scripts/make-npm-consumer.mjs` | Materialises the apps (`geneweave`, `geneweave-ui`) as a **standalone, apps-only workspace** with every `@weaveintel/*` dep resolved **from npm** — no `packages/`. One generator, used by both the CI and the prototype below. |
| `.github/workflows/integration-npm-consume.yml` | CI job: generate the consumer → `npm install` from the registry → `turbo build` → `turbo typecheck` → `vitest run`. Runs nightly, after a `Release`, or on demand. |

Run it yourself:

```bash
node scripts/make-npm-consumer.mjs /tmp/geneweave-community   # or any empty dir
cd /tmp/geneweave-community
npm install        # pulls @weaveintel/* from the registry
npm run build && npm run typecheck && npm test
```

Pin a specific framework version to test an upgrade before adopting it:

```bash
node scripts/make-npm-consumer.mjs /tmp/gw --version 0.1.1   # or `latest`, `^0.2.0`, …
```

## What the generator reconciles

Standalone consumption differs from the monorepo in three mechanical ways; the generator handles all
three so the copied app source is untouched:

1. **No `packages/`** — a clean root `package.json` with `workspaces: ["apps/*"]` only.
2. **tsconfig references** — drops every `../../packages/*` project reference (those come from npm now);
   keeps sibling-app references (`geneweave-api` → `geneweave-ui`).
3. **Dependency versions** — `@weaveintel/*` point at the registry version; the sibling app
   (`geneweave-ui`) stays a workspace (`*`), since it is never published.

## Prerequisite fixes made for this to be honest (not papered over)

- **Complete manifest.** `apps/geneweave` imported **9** framework packages it never declared
  (`artifacts`, `client`, `extraction`, the four `provider-*`, `voice`) — it only built because npm
  *hoisting* leaked them in. That is a latent bug for any standalone consumer, so the manifest now
  declares everything it imports (44 `@weaveintel/*` deps). No effect on the monorepo (they resolve to
  the workspace either way).
- **Workspace-optional tests.** Two `low-severity-stress` assertions read the **mobile client** source
  (`clients/mobile/…`), a sibling workspace absent in an apps-only consumer. They now `ctx.skip()` when
  that source isn't present — so they still run for real in the monorepo, and skip cleanly standalone.

## Proof — side by side

The same apps, consumed three ways, all green against the **published `@weaveintel/*@0.1.1`**:

| Consumer | Shape | Framework source | build / typecheck | unit tests |
|---|---|---|---|---|
| **In-repo (`Test` workflow)** | full monorepo | local `packages/*` (workspace) | ✅ | 2,135 pass |
| **Community prototype** (`make-npm-consumer.mjs`) | apps-only | `@weaveintel/*@0.1.1` from npm | ✅ 2/2, 3/3 | **2,131 pass**, 2 skip (mobile) |
| **Private commercial repo** (Phase 9) | apps-only fork | `@weaveintel/*@0.1.1` from npm | ✅ 2/2, 3/3 | 2,133 pass, 2 skip |

The community and private consumers are structurally identical (apps-only, npm-consuming); the private
one additionally vendors the geneWeave-specific StatsNZ vertical and carries commercial divergence.

## What this unblocks

With this green, splitting the community app into its own public repo becomes low-risk: this workflow
**is** the cross-repo regression net that would replace the in-monorepo `Test` coverage. Before a split,
point the CI at the app's new repo instead of the generated copy.

**Note on pre-publish validation:** because it installs *released* packages, this job can't catch a
regression introduced by an unpublished PR. To validate current source through the npm path before
publishing, publish the workspace to a local registry (e.g. verdaccio) and pass `--version` pointing at
it — a natural follow-up if pre-merge cross-repo coverage is wanted.
