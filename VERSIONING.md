# weaveIntel Versioning

weaveIntel follows **Fabric Versioning** — a semantic versioning scheme where each
major release is named after a fabric, assigned alphabetically from A to Z.

## Version Format

```
<major>.<minor>.<patch>  —  "<Fabric Name>"
```

| Component | Meaning |
|-----------|---------|
| **Major** | Breaking changes, new architecture. Named after the next alphabetical fabric. |
| **Minor** | New features, backward-compatible additions within the current fabric release. |
| **Patch** | Bug fixes, security patches, documentation corrections. |

## Fabric Codenames

Each major version is assigned a unique single-word fabric name from the
[Wikipedia List of Fabrics](https://en.wikipedia.org/wiki/List_of_fabrics),
progressing alphabetically.

| Major | Codename       | Fabric Origin |
|------:|----------------|---------------|
|     1 | **Aertex**     | Lightweight woven mesh fabric, invented in 1888 |
|     2 | **Batiste**    | Fine, sheer cotton or linen fabric |
|     3 | **Calico**     | Plain-woven textile from unbleached cotton |
|     4 | **Damask**     | Reversible figured fabric with a pattern woven into it |
|     5 | **Etamine**    | Loosely woven open-mesh fabric |
|     6 | **Flannel**    | Soft woven fabric, typically brushed for warmth |
|     7 | **Gauze**      | Thin, translucent fabric with an open weave |
|     8 | **Habutai**    | Smooth, lightweight Japanese silk |
|     9 | **Intarsia**   | Colorwork knitting technique producing patterned fabric |
|    10 | **Jersey**     | Soft, stretchy knit fabric |
|    11 | **Knit**       | Fabric produced by interlocking loops of yarn |
|    12 | **Linen**      | Strong, lustrous natural fiber fabric |
|    13 | **Muslin**     | Lightweight plain-weave cotton |
|    14 | **Nankeen**    | Durable buff-colored cotton cloth |
|    15 | **Organza**    | Thin, crisp, sheer fabric |
|    16 | **Percale**    | Closely woven plain-weave fabric |
|    17 | **Rinzu**      | Japanese figured silk |
|    18 | **Satin**      | Glossy smooth fabric with a lustrous surface |
|    19 | **Taffeta**    | Crisp, smooth woven fabric with a slight sheen |
|    20 | **Ultrasuede** | Synthetic ultra-microfiber material |
|    21 | **Velvet**     | Soft, dense-pile woven fabric |
|    22 | **Wadmal**     | Coarse, thick Scandinavian woolen fabric |
|    23 | **Zephyr**     | Light, fine-quality gingham or fabric |

> Letters X and Y are skipped due to limited single-word fabric options.
> If we ever reach v23, we've had a good run.

## How It Works

### Major Release (new fabric)

A major release introduces breaking changes or a significant architectural shift.
The version number increments and the codename advances to the next alphabet letter.

```
1.0.0  "Aertex"   →  First stable release
2.0.0  "Batiste"  →  Second major release (breaking changes)
3.0.0  "Calico"   →  Third major release
```

### Minor Release (same fabric)

Minor releases add features without breaking backward compatibility.
They stay under the same fabric codename.

```
1.0.0  "Aertex"   →  Initial release
1.1.0  "Aertex"   →  Added model pricing sync
1.2.0  "Aertex"   →  Added workflow engine
1.3.0  "Aertex"   →  Added knowledge graph
```

### Patch Release

Patch releases fix bugs and are always backward compatible.

```
1.1.0  "Aertex"   →  Feature release
1.1.1  "Aertex"   →  Fixed memory leak in model router
1.1.2  "Aertex"   →  Security patch for JWT validation
```

## GitHub Release Tags

Releases are tagged and published on GitHub with the following convention:

```
Tag:    v1.0.0
Title:  v1.0.0 — Aertex
Body:   Release notes (generated from CHANGELOG.md)
```

Minor releases:

```
Tag:    v1.1.0
Title:  v1.1.0 — Aertex
```

## Release Process

1. **Update `CHANGELOG.md`** — Add entries under the new version heading
2. **Bump versions** — Run `npm run release:bump -- <major|minor|patch>`
3. **Tag and push** — Run `npm run release:tag`
4. **GitHub Release** — The CI workflow creates a GitHub release automatically from the tag

## Current Release

| Version | Codename | Status |
|---------|----------|--------|
| 1.0.0   | Aertex   | Current |
