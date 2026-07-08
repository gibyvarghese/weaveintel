---
"@weaveintel/realm": minor
---

Tenancy realm Phase 3 — the per-tenant state overlay. Lets a tenant change a global default's
*disposition* — turn it off, reprioritise it, or pin it to a version — WITHOUT copy-on-write forking it.
It is a thin sparse sidecar (`realm-state.ts` / `realm-state-sql.ts` + `realmTenantStateDdl`): per
(tenant, family, logicalKey) it stores only the fields the tenant changed (`enabled` / `priority` /
`pinnedVersion`; null = inherit). Resolution is per-field nearest-wins down the tenant lineage — the
multi-tenant feature-flag / Kustomize base-overlay pattern — so a parent org can set policy for its whole
subtree and a child can override just one field. `resolveStateFor` merges a lineage's overlays in one
call; only an explicit `enabled:false` disables (null/true keep active); an all-null overlay clears
itself. In-memory reference + one dual-engine SQLite/Postgres store (upsert via ON CONFLICT, no recursive
SQL). Proven on the in-memory reference, real SQLite and real Postgres, with a 2,000-tenant toggle stress
test, hierarchy inheritance/override, adversarial-input security, and a real-LLM flagship (a model sets a
per-industry enable policy over shared skills; each tenant resolves its own — no forks).
