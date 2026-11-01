# @weaveintel/retrieval

## 0.2.0

### Added

- `weavePgVectorStore({ pool, dimensions, verifyPrincipal })`: a PostgreSQL + pgvector `VectorStore`
  whose `search(ctx, { principal, … })` refuses without a principal the host verifies, whose tenant
  must equal `ctx.tenantId`. Tenant, ACL and classification ≤ clearance are enforced in parameterised
  SQL; writes are tenant-scoped and need an ACL; optional transaction-local RLS setting (GAPS G-WI-18).
- `createPrincipalSeal(secret)`: HMAC-sealed principals with expiry. `pg` is a devDependency only.
