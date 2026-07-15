# weaveIntel Versioning

weaveIntel versions **two things on two independent tracks**, because they have two different audiences:

| Track | What | Scheme | Source of truth |
|---|---|---|---|
| **Libraries** | the published `@weaveintel/*` framework packages | **independent SemVer**, managed with **Changesets** | [`.changeset/`](.changeset/README.md) |
| **Product** | the **geneWeave** application (community + private editions) | **coordinated SemVer** with a **fabric codename on majors**, both editions in lockstep | the geneWeave repos' `package.json` + release tags |

> A library and the product move at their own pace: it is normal for `@weaveintel/realm` to be `0.4.0` while the
> geneWeave product is `1.0.0`. They are not the same number and are never bumped together.

---

## Track 1 — Libraries (`@weaveintel/*`)

Each published package carries its **own** SemVer `MAJOR.MINOR.PATCH` and advances **independently**:

| Component | Meaning (for that package's API) |
|-----------|----------------------------------|
| **Major** | breaking API change |
| **Minor** | backward-compatible feature |
| **Patch** | backward-compatible fix |

- **Managed by Changesets.** To record a change: `npx changeset` (pick the packages + bump type). To release:
  `npx changeset version` (applies bumps + writes changelogs) then `npx changeset publish`. See
  [`.changeset/README.md`](.changeset/README.md). Apps (`geneweave-api`, `geneweave-ui`, `desktop`, `mobile`,
  `live-agents-demo`) are in the changesets `ignore` list — they are not published to npm.
- **Tags** are per-package: `@weaveintel/<pkg>@x.y.z`.
- **Pre-1.0 today.** The framework is intentionally on `0.x` while its public surface is still settling — under
  SemVer, `0.x` signals the API may change between minors. Individual packages graduate to `1.0.0` when their API
  is declared stable; there is **no** requirement to bump them all together.
- **Supply chain:** packages are published from CI with **npm provenance** (Trusted Publishing) so consumers can
  verify which workflow run produced each artifact.

There is **no** fabric codename on library versions.

---

## Track 2 — Product (geneWeave)

The geneWeave application versions as **one product**, and **both editions share the same version number**:

```
<major>.<minor>.<patch>   —   majors also carry a fabric codename
```

| Component | Meaning (for the product) |
|-----------|---------------------------|
| **Major** | breaking change / new architecture / a data or deploy migration that isn't backward-compatible. Advances the **fabric codename**. |
| **Minor** | new features, backward-compatible. |
| **Patch** | fixes, security, docs — always backward-compatible. |

**Editions share the version.** *Community* and *private (enterprise)* release the **same `x.y.z`**; the edition
is a **separate field**, not part of the version number. This lockstep is what lets the in-app **Upgrade Center**
line up its edition check and version compare (`computeBumpType` maps directly onto the Major/Minor/Patch meanings
above, and the anti-rollback floor is a straight SemVer comparison).

**Codenames apply to product *majors* only** — never to minors, patches, or libraries:

```
1.0.0  "Aertex"    →  First GA
1.1.0  "Aertex"    →  Feature release (same fabric)
1.1.1  "Aertex"    →  Patch (same fabric)
2.0.0  "Batiste"   →  Next major (new fabric)
```

### Fabric codenames (product majors)

Each product major is named after a single-word fabric from the
[Wikipedia List of Fabrics](https://en.wikipedia.org/wiki/List_of_fabrics), alphabetically:

| Major | Codename | Major | Codename | Major | Codename |
|------:|----------|------:|----------|------:|----------|
| 1 | **Aertex** | 9 | Intarsia | 17 | Rinzu |
| 2 | Batiste | 10 | Jersey | 18 | Satin |
| 3 | Calico | 11 | Knit | 19 | Taffeta |
| 4 | Damask | 12 | Linen | 20 | Ultrasuede |
| 5 | Etamine | 13 | Muslin | 21 | Velvet |
| 6 | Flannel | 14 | Nankeen | 22 | Wadmal |
| 7 | Gauze | 15 | Organza | 23 | Zephyr |
| 8 | Habutai | 16 | Percale | | |

> Letters X and Y are skipped (limited single-word fabric options). If we ever reach v23 "Zephyr", we've had a
> good run.

### Release tags & the Upgrade Center

A product release is a **`v<x.y.z>` git tag** with a **GitHub Release** carrying an **Ed25519-signed
`manifest.json`** (its `version`, `edition`, `layers.code.repoTag = the tag`, `fileManifestDigest`, plus schema
and content layers). The running instance's Upgrade Center discovers, verifies, applies, and reconciles that
release. The end-to-end publisher steps live in the geneWeave repos' **`docs/RUNBOOKS.md` → *Publisher runbook —
cutting a release*** (and the engine itself in **`docs/UPGRADE_ENGINE.md`**); this document defines only the
*numbering* scheme.

---

## Current state

| Track | Where | State |
|---|---|---|
| Libraries | `@weaveintel/*` on npm | independent SemVer, **`0.x`** (e.g. `realm 0.4.0`, `upgrade 0.2.0`, most `0.1.x`) via Changesets |
| Product | geneWeave (community + private) | **`1.0.0` "Aertex"** — the first GA product line |

## Further reading

- [`.changeset/README.md`](.changeset/README.md) — the library (Changesets) release flow.
- geneWeave `docs/RUNBOOKS.md` — the *Publisher runbook* for cutting a signed product release.
- geneWeave `docs/UPGRADE_ENGINE.md` — how an instance consumes a release.
- [`VERSIONING_REVIEW_AND_ROADMAP_2026.md`](VERSIONING_REVIEW_AND_ROADMAP_2026.md) — the review + phased rollout that established this scheme.
