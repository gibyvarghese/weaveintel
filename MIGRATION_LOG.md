# weaveIntel repo split — migration log

**Goal (as decided with the operator):** an **open-core** split.
- **Public repo `gibyvarghese/weaveintel` (MIT):** keeps the library (`packages/*`, published to npm) **and** today's apps as a frozen **community edition** — adopters keep perpetual access.
- **Private repo `gibyvarghese/geneweave`:** a fork of the apps for all **future commercial development**, consuming the library **strictly as published npm packages** (no workspace/relative/file references).

**Config in effect:** `NPM_SCOPE=@weaveintel`, `PRIMARY_APP=geneweave`, `DRY_RUN=true` (no pushes, no publishes — dry-run + local tarballs), `PRESERVE_HISTORY=true`, package manager = **npm** (repo is configured for npm; pnpm is blocked), consumption = **strict npm boundary**, app license = **MIT** (unchanged).

Branch strategy: work happens on `repo-split`; snapshot preserved on branch `pre-split-snapshot` + tag `pre-split-2026-07-03`. Split operates from `collab-phase-0` state (most complete + buildable); on go-live it will be merged to `main` as the community edition.

---

## Phase 0 — Preflight audit (read-only) ✅

**Toolchain:** git 2.50, node 20.17, npm 10.8, gh 2.87 (authed as `gibyvarghese`). ⚠️ `pnpm` blocked (npm repo). ⚠️ `git-filter-repo` NOT installed — will `pip install` in Phase 2 (needed for `PRESERVE_HISTORY=true`).

**Working tree:** clean of tracked changes (0 modified). 4 untracked, non-code items left alone (`.claude/`, `GeneWeave Design System/`, two `WEAVENOTES_*_2026.md`).

**Workspace:** 87 `packages/*`, 3 `apps/*` (`geneweave`=`@weaveintel/geneweave-api`, `geneweave-ui`=`@weaveintel/geneweave-ui`, `live-agents-demo`), 4 `clients/*` (`api-client`, `desktop`, `mobile`, `tokens`=`@geneweave/tokens`).

**Dependency footprint (internal `@weaveintel/*` + `@geneweave/*`):**
- `@weaveintel/geneweave-api` transitive closure: **61** internal packages.
- `@weaveintel/geneweave-ui` closure: 3.
- **Union to publish for the private geneWeave repo: ~60 of 87 packages.**

**Boundary health — no BLOCKING structural defects (all clean):**
- `packages/* → apps/*` dependencies: **0**.
- `packages/*` importing an app by path (`../../apps/...`): **0**.
- Apps deep-importing library internals (`@weaveintel/x/src|dist/...`): **0**.
- Apps importing the library by relative cross-boundary path (`../../packages/...`): **0**.
- Apps consume the library purely by package name — the split boundary is already correct.

**Publish-readiness — only two trivial, mechanical gaps (structure is already right):**
- ✅ **All 87** packages: `main`/`types` → `./dist/...`, `outDir: dist`, and a `build` script. None `private:true`.
- ⚠️ **87/87** lack `publishConfig.access: "public"` (required to publish scoped packages publicly).
- ⚠️ **70/87** lack a `files` field / `.npmignore` (17 already have `files: ["dist"]`).
- Both are safe to batch-fix (`files: ["dist"]` is valid for all since every package outputs to `dist`).

**Snapshot:** branch `pre-split-snapshot` + tag `pre-split-2026-07-03` created on HEAD. Work branch `repo-split` created.

**Phase 0 verdict:** feasible and low-risk. The clean boundary means the strict-npm-boundary model works without refactoring. Remaining work is mechanical: add two package.json fields to ~87/70 packages, build, pack, verify, then fork + rewrite the apps.

---

## Phase 1 — Make the library publishable + (dry-run) publish ✅

**Publish-readiness fixes (committed):** added `publishConfig.access: "public"` to **all 87** packages and `files: ["dist"]` to the **70** that lacked it. No structural changes needed (main/types/build/exports were already correct).

**Build:** `turbo build --filter='./packages/*'` → 88 tasks successful; **all 87 packages have `dist/`**.

**Pack + verify (the proof the packages work as real node modules):**
- Packed the **59-package geneWeave closure** to tarballs (kept for Phase 3 in scratchpad `tarballs/`).
- Installed **all 59 tarballs into a clean throwaway project** (`/private/tmp/split-verify`) → 256 packages resolved, exit 0.
- Ships **`dist/` only, no `src/`** (verified for core/notes/i18n) — `files:["dist"]` works.
- **Runtime** smoke test of real public APIs (`@weaveintel/i18n` `createTranslator`/`resolveLocaleChain`, `@weaveintel/collaboration` `selectSuggestions`/`CURATED_PROMPTS`) → OK.
- **Type-check** (`tsc --noEmit`) of a consumer `.ts` against the installed `.d.ts` → 0 errors.

**Publish (DRY_RUN=true):** `npm publish --dry-run --access public` for every closure package → **59/59 OK, 0 failures**. Versions currently `0.0.1` (a few `0.1.0`). Full list recorded in scratchpad `publish-dryrun.txt`.

> ⚠️ Follow-up for the real (non-dry-run) publish: decide a coordinated initial version (e.g. bump the whole set to `0.1.0` or `1.0.0`) so the private app's `^` ranges are consistent, and wire Changesets for ongoing releases. Not blocking in dry-run.
