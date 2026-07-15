# weaveIntel & geneWeave — Versioning Review and Roadmap (mid‑2026)

> **Status:** review + proposal. **No versioning changes have been made** — this document brings the current
> state, the [`VERSIONING.md`](VERSIONING.md) rules, and mid‑2026 best practice together into one decision and a
> phased rollout across **weaveIntel (GitHub + npm)** and **geneWeave (community + private)**.
> Open decisions for the owner are called out in **§6**; nothing is implemented until those are confirmed.

---

## 1. Executive summary

Three findings drive everything below:

1. **There are two contradictory schemes on paper vs. in practice.** [`VERSIONING.md`](VERSIONING.md) describes
   **"Fabric Versioning"** — a *locked* scheme where every package bumps in concert to `v1.0.0 "Aertex"`. But the
   repo actually runs **Changesets with independent, per‑package SemVer** (`@weaveintel/realm@0.4.0`,
   `@weaveintel/upgrade@0.2.0`, `@weaveintel/workflows@0.1.3`, most others `0.1.1–0.1.2`). The fabric‑locked
   tooling (`scripts/bump-version.mjs`, the codename in `release.yml`) exists but is **not** what versions the
   packages. The two have quietly diverged.

2. **geneWeave has no versioning strategy wired at all.** Both editions' apps report `1.0.0`, but **neither repo
   has a single git tag, a release workflow, or a `VERSIONING.md`** (private also lacks a `CHANGELOG.md`). The
   version number is effectively a constant.

3. **This directly limits the new Upgrade Center.** The upgrade engine reads the deployed version from
   `package.json` and expects **`v<version>` git tags + GitHub releases carrying a signed manifest** (with
   `layers.code.repoTag` + `fileManifestDigest`). geneWeave produces none of these today, so the self‑upgrade
   flow can only be demonstrated with a mock feed — not driven from a real release.

**The recommendation (detail in §5):** run **two explicit tracks** —
- **`@weaveintel/*` libraries →** independent **SemVer via Changesets** (keep what already works) **+ npm Trusted
  Publishing + provenance** (the 2026 supply‑chain standard). Retire the fabric‑*locked* claim for packages.
- **geneWeave product (both editions) →** one **coordinated product SemVer** line, shared by community + private,
  with **fabric codenames as a marketing layer on majors only**, and a real **signed‑release pipeline** that
  emits the `v<version>` tags + manifests the Upgrade Center consumes.

---

## 2. Current state — the facts

### 2.1 weaveIntel monorepo (`/Users/gibyvarghese/weaveintel`)

| Aspect | Reality |
|---|---|
| Root `package.json` version | `1.0.0` |
| **Package versions** | **Independent SemVer, drifted:** `realm 0.4.0`, `upgrade 0.2.0`, `skills/workflows 0.1.3`, ~8 pkgs `0.1.2`, ~30+ pkgs `0.1.1` |
| **Versioning tool actually used** | **Changesets** (`.changeset/config.json`: `access: public`, `fixed: []`, `linked: []`, `updateInternalDependencies: patch`, apps in `ignore`) |
| Fabric tooling | `scripts/bump-version.mjs` (fabric‑codename‑aware, operates on the **root** version) + `scripts/tag-release.mjs` — **present but not the package source of truth** |
| Git tags | Mixed: **per‑package** (`@weaveintel/realm@0.1.0…0.4.0`, `@weaveintel/identity@0.1.2`) + **milestones** (`community-v1`, `pre-split-2026-07-03`, `v0.1.0-restructure`). **No `v1.0.0` fabric tag.** |
| CHANGELOG | Exists; header claims *"adheres to Fabric Versioning"* but the top entry is **`[0.1.1] — The open-core restructure`** ("released together at 0.1.1"), i.e. **SemVer 0.x, not `1.0.0 Aertex`** |
| `release.yml` | Triggers on `push: tags`; builds; creates a **GitHub Release** titled `<tag> — <codename>` from `CHANGELOG.md`. **npm publish is not clearly wired in this workflow** — publishing appears to be Changesets‑driven/manual (worth confirming). |

**Interpretation:** the packages are on a **healthy, modern independent‑SemVer‑via‑Changesets** track. The
**fabric‑locked** scheme in `VERSIONING.md` + `bump-version.mjs` is **aspirational and contradictory** — it was
written for a future coordinated `1.0.0` but the day‑to‑day reality is Changesets. They should be reconciled, not
both kept.

### 2.2 geneWeave community (public — `gibyvarghese/geneweave-community`)

| Aspect | Reality |
|---|---|
| `apps/geneweave` version | `1.0.0` (root `0.0.0`) |
| Git tags | **none** |
| Release/publish workflow | **none** (`.github/workflows`: `test.yml`, `ci.yml` only) |
| `VERSIONING.md` | **absent** |
| `CHANGELOG.md` | present |

### 2.3 geneWeave private (`gibyvarghese/geneweave`)

| Aspect | Reality |
|---|---|
| `apps/geneweave` version | `1.0.0` (root `1.0.0`) |
| Git tags | **none** |
| Release/publish workflow | **none** (`test.yml`, `ci.yml`) |
| `VERSIONING.md` / `CHANGELOG.md` | **both absent** |

---

## 3. Compliance with the documented rules ([`VERSIONING.md`](VERSIONING.md))

`VERSIONING.md` defines **Fabric Versioning**: `MAJOR.MINOR.PATCH` where each **major** gets an alphabetical
fabric codename (1 = Aertex … 23 = Zephyr), all packages bumped in concert via `release:bump`, GitHub tags
`v1.0.0` titled `v1.0.0 — Aertex`, and a stated *"Current Release: 1.0.0 Aertex — Planned, not yet released"*.

| Repo | Follows Fabric Versioning? | Notes |
|---|---|---|
| **weaveIntel** | **Partially / contradictorily** | The *tooling and CI title* implement fabric codenames, but *package versions* are independent Changesets SemVer at `0.x` and the CHANGELOG is `0.1.1`, not `1.0.0 Aertex`. The "locked, in‑concert" rule is **not** in force. |
| **geneWeave community** | **No** | No tags, no release process, no `VERSIONING.md`; version pinned at `1.0.0` by hand. |
| **geneWeave private** | **No** | Same, plus no `CHANGELOG.md`. |

**Bottom line:** the only place the fabric idea shows up is a release‑title string and an unused bump script;
`VERSIONING.md` does not describe how versions are actually maintained anywhere.

---

## 4. Mid‑2026 best practice (researched)

**Library / monorepo versioning → Changesets + independent SemVer.** For a monorepo of many *publishable*
packages, Changesets is the current best‑in‑class: it versions each package independently, understands
inter‑package dependency bumps, and makes release intent **explicit per PR** (a checked‑in changeset file states
which packages bump and how) rather than inferring from commit messages. It is the recommended pairing with
Turborepo/Nx workflows.
([changesets docs](https://changesets-docs.vercel.app/),
[semantic-release vs changesets 2026](https://www.pkgpulse.com/guides/semantic-release-vs-changesets-vs-release-it-release-2026),
[Vercel Academy](https://vercel.com/academy/production-monorepos/changesets-versioning))

**npm publishing → Trusted Publishing + provenance.** The 2026 standard is **OIDC Trusted Publishing** from
GitHub Actions (no long‑lived `NPM_TOKEN`), which **auto‑generates provenance attestations** so consumers can
verify which workflow run built each artifact. Best practice is to set the npm account so **Trusted Publishing is
the only publish path**, neutralising token leakage.
([npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[npm provenance](https://docs.npmjs.com/generating-provenance-statements/),
[GitHub blog: npm provenance](https://github.blog/security/supply-chain-security/introducing-npm-package-provenance/))

**Product / application versioning → SemVer, optionally with codenames; CalVer only for pure cadence.** SemVer
suits libraries, frameworks and APIs (consumers trust minor/patch not to break). CalVer (`YYYY.MM`) suits
enterprise software shipped on a fixed calendar. A widely‑used **hybrid** is SemVer for the libraries + a distinct
**product** version for the app, with **release codenames** layered on majors for marketing (the Ubuntu model).
([SemVer vs CalVer — SensioLabs](https://sensiolabs.com/blog/2025/semantic-vs-calendar-versioning),
[WorkOS: making sense of versioning](https://workos.com/blog/software-versioning-guide),
[CalVer](https://calver.org/))

**Self‑update alignment.** The Upgrade Center already implements the TUF/Sparkle‑style model (signed manifest with
per‑file hashes, edition, freshness, anti‑rollback). Its **`computeBumpType` (patch/minor/major) and anti‑rollback
floor assume SemVer** — so the product version *must* stay SemVer for the upgrade UX to be meaningful.

---

## 5. The decided approach — two explicit tracks

> **One rule to remember:** *libraries and the product are different audiences and version independently.*

### Track A — `@weaveintel/*` libraries (the SDK/framework)

- **Independent SemVer via Changesets** — keep the existing setup; make it the *single* source of truth.
- **Retire the fabric‑*locked* claim for packages.** Delete/repurpose `bump-version.mjs`'s package‑locking; the
  fabric codename is **not** a library concept.
- **npm Trusted Publishing + provenance** in release CI (drop any `NPM_TOKEN`); enforce Trusted Publishing as the
  only publish path on the npm org.
- **Per‑package tags** (`@weaveintel/<pkg>@x.y.z`) — already the norm; keep. CHANGELOG stays Changesets‑generated.
- Stay `0.x` until the framework's public API is declared stable, then a deliberate `1.0.0` per package (or a
  coordinated `1.0.0` sweep if you want a "framework GA" moment — a *one‑time* linked bump, not an ongoing lock).

### Track B — geneWeave product (community + private, in lockstep)

- **One coordinated product SemVer** shared by **both editions** (same `x.y.z`; the *edition* — community vs
  enterprise — is a separate field, already present in the upgrade manifest). Community and private release the
  **same version number** so the Upgrade Center's edition check and version compare line up.
- **`computeBumpType` semantics are the contract:** major = breaking/architecture, minor = features, patch =
  fixes — exactly what the Upgrade Center badges.
- **Fabric codenames layer onto product *majors* only** (marketing: "geneWeave 1.0 — Aertex"), never onto
  minors/patches, never onto libraries. This preserves the fun of `VERSIONING.md` without the locked‑everything
  cost.
- **Real signed‑release pipeline (the missing piece):** each product release cuts a **`v<x.y.z>` git tag** and a
  **GitHub Release** carrying the **Ed25519‑signed upgrade manifest** (`version`, `edition`, `layers.code.repoTag`
  = the tag, `layers.code.fileManifestDigest` = the source‑tree baseline digest, schema/content layers). This is
  what turns the Upgrade Center from "demo with a mock feed" into "upgrades from your real GitHub releases."

### Why this reconciles everything

- It **keeps** the modern, already‑working Changesets library flow (no churn for `@weaveintel/*`).
- It **fixes** the real gap (geneWeave has no releasable version line or tags).
- It **feeds** the Upgrade Center I built (tags + signed manifests + SemVer bump semantics).
- It **resolves** the `VERSIONING.md` contradiction by giving the fabric idea a correct, smaller home (product
  majors), instead of an incorrect global one.

---

## 6. Decisions — CONFIRMED

All four settled by the owner (the recommended options); the plan below executes against these.

| # | Decision | Confirmed choice |
|---|---|---|
| 1 | **Product starting version** | **`1.0.0 "Aertex"`** — geneWeave's first real release is `v1.0.0`; this is the anti‑rollback floor and commits to no data/deploy breakage without a major bump. |
| 2 | **Fabric codenames** | **Keep — product *majors* only** (`geneWeave 1.0 — Aertex`); never on minors/patches, never on `@weaveintel/*`. |
| 3 | **`@weaveintel/*` libraries** | **Stay independent `0.x` via Changesets;** a coordinated framework `1.0.0` is deferred (may later align with a product major). |
| 4 | **Edition lockstep** | **Automated:** a shared `release:product` script bumps both repos + a **CI guard** fails if community and private product versions diverge. |

**Consequence:** product runs on coordinated SemVer starting `1.0.0 "Aertex"`; libraries run on independent `0.x`
via Changesets — two tracks by design. Proceed from **Phase 0**.

---

## 7. Phased implementation plan

> Each phase is independently shippable and reversible. Phases 0–2 are documentation/config only (low risk);
> Phases 3–5 add the signed‑release pipeline that the Upgrade Center consumes. **Nothing starts until §6 is
> confirmed.**

### Phase 0 — Reconcile the documentation (the contradiction)
- Rewrite [`VERSIONING.md`](VERSIONING.md) to describe the **two tracks** (libraries = Changesets SemVer;
  product = coordinated SemVer + codename‑on‑majors). Remove the "all packages locked to one version" language.
- State the **edition rule** (community + private share the product version; edition is a separate field).
- Copy the reconciled `VERSIONING.md` into **both geneWeave repos** (community + private), plus add the missing
  `CHANGELOG.md` to **private**. Cross‑link all three so there is one canonical description.
- *Deliverable:* consistent docs; **no version numbers change.**

### Phase 1 — weaveIntel libraries: harden the Changesets + npm track
- Confirm/normalise `.changeset/config.json`; document the per‑PR changeset workflow in `CONTRIBUTING`.
- Add a **release CI job** that runs `changeset version` → `changeset publish` with **npm Trusted Publishing +
  `--provenance`** (remove any `NPM_TOKEN`); set the npm org to Trusted‑Publishing‑only.
- Repurpose `bump-version.mjs`/`tag-release.mjs`: keep only what's still useful (e.g. product‑side codename help);
  delete the package‑locking path so there's a single source of truth.
- *Deliverable:* every `@weaveintel/*` publish is provenance‑attested; versions remain independent SemVer.

### Phase 2 — geneWeave product version line
- Establish the **product version** in both repos (per §6.1) and a **lockstep check** (§6.4): a CI step failing
  if community and private `apps/geneweave/package.json` versions diverge.
- Add a product `CHANGELOG.md` convention (Keep‑a‑Changelog) to both editions.
- *Deliverable:* a single, intentional product version shared by both editions, with a guardrail.

### Phase 3 — Signed release pipeline (Upgrade Center alignment) — **the key enabler**
- Add a **release workflow** to both geneWeave repos that, on a `v<x.y.z>` tag:
  1. builds; 2. computes the **source‑tree baseline digest** (`fileManifestDigest`, reusing the engine's
     `generateSourceBaselines`/`baselineDigest`); 3. assembles the manifest body (`version`, `edition`,
     `layers.code.repoTag = tag`, schema/content layers from the migrations/seed diff); 4. **Ed25519‑signs** it
     (reuse `@weaveintel/upgrade` `buildManifest`/`signManifest`); 5. attaches `manifest.json` to a **GitHub
     Release**.
- Publish the **trusted public keys** for adopters (the Upgrade Center's `trustedKeysPem`).
- *Deliverable:* the Upgrade Center can now `check` against **real** community/private releases — the mock feed
  in the demo becomes production reality. (This closes the loop with the version‑panel + one‑click‑upgrade work.)

### Phase 4 — Automate bump/tag/release end‑to‑end
- A `release:product` script (both repos): bump the product version, update `CHANGELOG`, tag `v<x.y.z>`, push →
  the Phase‑3 workflow signs + publishes. Codename applied automatically on majors.
- Optional cadence policy (SemVer‑by‑default; consider a CalVer *display* alias only if a fixed calendar cadence
  emerges — not recommended now).
- *Deliverable:* one‑command product releases; libraries and product each release on their own track.

### Phase 5 — Governance, verification, docs
- Adopter‑facing docs: "how geneWeave is versioned," "how to verify a release's provenance," "how the Upgrade
  Center trusts a release." Fold into `docs/UPGRADE_ENGINE.md`'s source‑config section.
- Add CI checks: SemVer‑valid tags, anti‑rollback (no tag ≤ latest), manifest‑signature verification on release,
  edition/version lockstep.
- *Deliverable:* the scheme is documented, enforced, and self‑verifying.

---

## 8. What explicitly does **not** change

- **`@weaveintel/*` package version numbers** — the independent‑SemVer/Changesets track is already correct; we
  only add provenance and remove the contradictory locked‑fabric tooling.
- **No CalVer migration** — SemVer stays, because the Upgrade Center's bump banding and anti‑rollback depend on it.
- **No forced "1.0.0 sweep"** of the libraries unless the owner opts into a framework‑GA moment (§6.3).

---

### Appendix — sources

- Changesets: [docs](https://changesets-docs.vercel.app/) ·
  [vs semantic-release/release-it 2026](https://www.pkgpulse.com/guides/semantic-release-vs-changesets-vs-release-it-release-2026) ·
  [Vercel Academy](https://vercel.com/academy/production-monorepos/changesets-versioning)
- npm supply‑chain: [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) ·
  [Provenance](https://docs.npmjs.com/generating-provenance-statements/) ·
  [GitHub: introducing npm provenance](https://github.blog/security/supply-chain-security/introducing-npm-package-provenance/)
- SemVer vs CalVer / product versioning: [SensioLabs](https://sensiolabs.com/blog/2025/semantic-vs-calendar-versioning) ·
  [WorkOS](https://workos.com/blog/software-versioning-guide) · [CalVer](https://calver.org/)
- Internal: [`VERSIONING.md`](VERSIONING.md) · `docs/UPGRADE_ENGINE.md` (geneWeave) · `@weaveintel/upgrade` (manifest/signing)
