# Live-Agents Implementation Audit

## Scope
- Reviewed implementation intent in [docs/liveagent.md](docs/liveagent.md).
- Reviewed package and app code for:
  - completeness vs documented implementation requirements
  - placeholders and scaffold leftovers
  - security risks
  - performance and memory leak risks
  - redundant or fragile logic
  - silent error swallowing
- Reviewed these implementation areas:
  - [packages/live-agents/src](packages/live-agents/src)
  - [apps/live-agents-demo/src](apps/live-agents-demo/src)
  - [packages/tools-webhook/src](packages/tools-webhook/src)
  - [packages/tools-filewatch/src](packages/tools-filewatch/src)
  - [examples](examples)

## Verification Run
- PASS: `npm run build -w @weaveintel/live-agents`
- PASS: `npm test -w @weaveintel/live-agents` (31 tests)
- PASS: `npm run build -w @weaveintel/live-agents-demo`
- PASS: `npm test -w @weaveintel/live-agents-demo` (1 test)
- PASS: `npm run build -w @weaveintel/tools-webhook`
- PASS: `npm test -w @weaveintel/tools-webhook` (5 tests)
- PASS: `npm run build -w @weaveintel/tools-filewatch`
- PASS: `npm test -w @weaveintel/tools-filewatch` (3 tests)
- PASS: `npx tsc --noEmit examples/comprehensive-live-agents-workflow.ts`
- PASS: `npx tsx examples/comprehensive-live-agents-workflow.ts`

## Delta Fixes Applied
- Fixed and rewrote [examples/comprehensive-live-agents-workflow.ts](examples/comprehensive-live-agents-workflow.ts) to use actual exported APIs from [packages/live-agents/src/index.ts](packages/live-agents/src/index.ts).
- Hardened webhook tool in [packages/tools-webhook/src/webhook.ts](packages/tools-webhook/src/webhook.ts):
  - host allow-list/block-list and private-network guard
  - request timeout and max response size controls
  - auth types: `none`, `bearer`, `basic`, `api_key`
  - optional token provider and bearer refresh-on-401 retry
- Added webhook hardening tests in [packages/tools-webhook/src/webhook.test.ts](packages/tools-webhook/src/webhook.test.ts) for host allow-list and token refresh retry.
- Hardened filewatch path safety and list performance in [packages/tools-filewatch/src/filewatch.ts](packages/tools-filewatch/src/filewatch.ts):
  - robust containment check using `path.relative`
  - parallel stat calls for lower latency

## Tool Auth and Token Review

### Auth Capability Matrix
- Strong multi-auth + refresh support:
  - [packages/tools-enterprise/src/auth/manager.ts](packages/tools-enterprise/src/auth/manager.ts): supports `basic`, `api_key`, `bearer`, `service_account`, `oauth2_authorization_code`, `oauth2_client_credentials`, `oidc`, and refresh-token flow.
- Multi-auth, no built-in token refresh orchestration:
  - [packages/tools-http/src/client.ts](packages/tools-http/src/client.ts): supports `api_key`, `bearer`, `basic`, `oauth2` headers but expects caller-managed token lifecycle.
  - [packages/tools-social/src/base.ts](packages/tools-social/src/base.ts) and [packages/tools-social/src/types.ts](packages/tools-social/src/types.ts): supports `oauth2`, `api_key`, `bearer`; token expiry fields exist, but refresh flow is not centrally enforced.
- OAuth bearer token expected from execution context (no refresh in package):
  - [packages/tools-gmail/src/gmail.ts](packages/tools-gmail/src/gmail.ts)
  - [packages/tools-outlook/src/outlook.ts](packages/tools-outlook/src/outlook.ts)
  - [packages/tools-gdrive/src/gdrive.ts](packages/tools-gdrive/src/gdrive.ts)
  - [packages/tools-dropbox/src/dropbox.ts](packages/tools-dropbox/src/dropbox.ts)
  - same pattern observed for `gcal`, `onedrive`, `outlook-cal`, `slack` tool packages.
- Non-external/local tools where auth is not expected:
  - [packages/tools-filewatch/src/filewatch.ts](packages/tools-filewatch/src/filewatch.ts)
  - `tools-time`, `tools-imap` (depending on adapter usage and runtime context setup).

### Gaps and Recommended Resolution
1. Add a shared auth facade for SaaS tools:
   - route token acquisition/refresh through a common provider interface (similar to enterprise AuthManager), instead of per-tool direct `ctx.metadata` extraction.
2. Standardize token refresh hooks:
   - for OAuth tools, add optional `tokenProvider` in MCP server options with `getToken` and `refreshToken`.
3. Standardize auth metadata schema:
   - avoid ad-hoc metadata keys per tool by introducing consistent key naming and docs in each tool README.
4. Add explicit auth-mode tests for each external tool package:
   - success with valid token
   - failure with missing token
   - refresh/retry path where applicable

## Findings (Ordered by Severity)

### 1) Critical [Resolved]: Comprehensive example was not runnable and referenced nonexistent API
- Evidence:
  - [examples/comprehensive-live-agents-workflow.ts](examples/comprehensive-live-agents-workflow.ts#L24)
  - [examples/comprehensive-live-agents-workflow.ts](examples/comprehensive-live-agents-workflow.ts#L67)
  - [examples/comprehensive-live-agents-workflow.ts](examples/comprehensive-live-agents-workflow.ts#L288)
- Impact:
  - The example cannot compile and cannot be used as reference implementation.
  - It contradicts the delivery claim for complete phase documentation/examples.
- Resolution:
  1. Rewrite the example to use currently exported runtime APIs from [packages/live-agents/src/index.ts](packages/live-agents/src/index.ts).
  2. Add CI/typecheck for this file (examples are currently outside TS project refs in [tsconfig.json](tsconfig.json#L1)).
  3. Add an example smoke test step that executes this file directly.

### 2) Critical: Redis state store is not Redis-backed
- Evidence:
  - Contract requires Redis coordination store: [docs/liveagent.md](docs/liveagent.md#L861)
  - Current implementation delegates to in-memory store: [packages/live-agents/src/state-store.ts](packages/live-agents/src/state-store.ts#L714)
- Impact:
  - Multi-worker/process claims about distributed lease/claim semantics are not real for Redis mode.
  - Risk of duplicate execution and incorrect assumptions in production adoption.
- Resolution:
  1. Implement real Redis-backed state operations for tick claiming, idempotency keys, and routing indexes.
  2. Add integration tests with two separate processes against Redis.
  3. Mark current method as explicit stub if real Redis is deferred.

### 3) High: Postgres demo state store persists only a subset of StateStore writes
- Evidence:
  - Persistence hooks are only implemented for 7 save methods: [apps/live-agents-demo/src/postgres-state-store.ts](apps/live-agents-demo/src/postgres-state-store.ts#L81)
  - Documented app scope expects broad table coverage including external events/routes: [docs/liveagent.md](docs/liveagent.md#L1016)
- Impact:
  - Non-overridden methods write only to in-memory proxy target and are lost on restart.
  - Behavior diverges from app persistence expectations in the implementation spec.
- Resolution:
  1. Add persistence adapters for all mutating StateStore methods.
  2. Expand migrations to all corresponding `la_*` tables.
  3. Add restart-resilience integration test: write entity -> restart -> verify entity exists.

### 4) High: Demo API has no auth/JWT gate despite documented requirement
- Evidence:
  - Requirement calls for JWT auth: [docs/liveagent.md](docs/liveagent.md#L1009)
  - Routes are open writes with no auth middleware: [apps/live-agents-demo/src/app.ts](apps/live-agents-demo/src/app.ts#L474)
- Impact:
  - Any caller can create meshes/agents/contracts/messages/ticks in demo deployment.
  - Violates security model and creates confusion for adopters.
- Resolution:
  1. Add JWT validation middleware (or minimal bearer token gate) before `/api/*` mutation routes.
  2. Enforce principal checks for human-only operations at API boundary.
  3. Add auth-required tests for all endpoints.

### 5) High [Resolved]: Webhook tool permitted unrestricted outbound requests (SSRF risk)
- Evidence:
  - Arbitrary target URL in fetch: [packages/tools-webhook/src/webhook.ts](packages/tools-webhook/src/webhook.ts#L30)
  - No host allowlist or scheme validation.
- Impact:
  - Tool can be used to reach internal metadata endpoints or private network targets.
- Resolution:
  1. Enforce URL policy: allowed schemes (`https`), host allowlist/denylist, optional CIDR block restrictions.
  2. Add request timeout and max response size to prevent hanging/large body abuse.
  3. Add tests for blocked URLs and timeout behavior.

### 6) High: MCP session cache key is account-only, not account+agent identity
- Evidence:
  - Cache keyed by account ID: [packages/live-agents/src/mcp-session-provider.ts](packages/live-agents/src/mcp-session-provider.ts#L27)
  - Retrieval uses `cache.get(account.id)`: [packages/live-agents/src/mcp-session-provider.ts](packages/live-agents/src/mcp-session-provider.ts#L56)
- Impact:
  - Different agents using same account can reuse a session created with a different runtime identity/scope.
  - Can violate intended identity isolation and audit attribution.
- Resolution:
  1. Key cache by `(account.id, agent.id)` or `(account.id, identity.id)`.
  2. Include session TTL/eviction and explicit close-on-idle.
  3. Add tests for cross-agent account reuse ensuring identity separation.

### 7) Medium [Resolved]: Filewatch path traversal boundary check was fragile
- Evidence:
  - Uses string prefix check only: [packages/tools-filewatch/src/filewatch.ts](packages/tools-filewatch/src/filewatch.ts#L30)
- Impact:
  - Prefix checks can be bypassed on sibling paths (`/base` vs `/base2`) depending on normalized values.
- Resolution:
  1. Use `path.relative(base, full)` and reject if it starts with `..` or is absolute.
  2. Normalize case handling where relevant.
  3. Add traversal tests for sibling-prefix bypass patterns.

### 8) Medium [Resolved]: Filewatch list did sequential fs.stat calls (N+1 latency)
- Evidence:
  - Sequential loop with `await fs.stat`: [packages/tools-filewatch/src/filewatch.ts](packages/tools-filewatch/src/filewatch.ts#L39)
- Impact:
  - Slow on large directories and expensive over network/disks.
- Resolution:
  1. Use bounded parallelism for stat calls.
  2. Offer pagination/limit in `filewatch.list` input schema.

### 9) Medium: Request body parsing is unbounded in demo app (memory DoS)
- Evidence:
  - Unbounded buffer collection from request stream: [apps/live-agents-demo/src/app.ts](apps/live-agents-demo/src/app.ts#L32)
- Impact:
  - Large payloads can exhaust memory and crash process.
- Resolution:
  1. Add max body size guard and early abort (e.g., 1-2 MB for demo APIs).
  2. Return 413 for oversized payloads.

### 10) Medium: External event processing catches and masks exceptions
- Evidence:
  - Catch block in handler: [packages/live-agents/src/runtime.ts](packages/live-agents/src/runtime.ts#L634)
  - Returns success-shaped output with zero routed messages: [packages/live-agents/src/runtime.ts](packages/live-agents/src/runtime.ts#L656)
- Impact:
  - Callers cannot distinguish hard failure vs legitimate no-match unless they inspect stored event records.
  - Operational observability depends on side effects, not API contract.
- Resolution:
  1. Return error metadata in result or throw after persisting FAILED event.
  2. Keep persisted failure state, but surface failure clearly to caller.

### 11) Low: Missing changelog entry for live-agents phase additions
- Evidence:
  - Requirement states CHANGELOG update: [docs/liveagent.md](docs/liveagent.md#L1145)
  - Current changelog has no live-agents entry in Unreleased: [CHANGELOG.md](CHANGELOG.md)
- Impact:
  - Release notes do not reflect large new framework surface.
- Resolution:
  1. Add Unreleased section for live-agents phases and tool package additions.

### 12) Low: Not all tools packages have READMEs despite requirement
- Evidence:
  - Requirement says each tools package should have README: [docs/liveagent.md](docs/liveagent.md#L1125)
  - Missing READMEs in multiple tools packages, including [packages/tools-gmail](packages/tools-gmail), [packages/tools-outlook](packages/tools-outlook), [packages/tools-slack](packages/tools-slack), [packages/tools-gdrive](packages/tools-gdrive), and others.
- Impact:
  - Discoverability and onboarding are inconsistent across tooling surface.
- Resolution:
  1. Add minimum README template to each tools package (purpose, auth model, tools/resources, examples, tests, security notes).

### 13) Low: Global docs ignore rule creates future documentation drift risk
- Evidence:
  - Docs are globally ignored in git: [.gitignore](.gitignore#L9)
- Impact:
  - Future docs can be accidentally omitted unless force-added.
- Resolution:
  1. Remove global `/docs/` ignore or replace with targeted ignore patterns.

## Placeholder / Scaffold Check
- No active TODO/FIXME placeholders found in reviewed source.
- One scaffold-era error class remains in [packages/live-agents/src/errors.ts](packages/live-agents/src/errors.ts#L10), but current runtime paths are implemented and tests pass.

## Silent Error Handling Summary
- Good: Most critical errors are thrown (binding invariants, authority violations, cross-mesh bridge checks).
- Needs improvement:
  - External event processing currently persists failure but does not propagate failure to caller (Finding 10).
  - Demo app returns raw internal error strings to clients (information exposure risk): [apps/live-agents-demo/src/app.ts](apps/live-agents-demo/src/app.ts#L544).

## Recommended Remediation Order
1. Fix broken comprehensive example and add CI typecheck for it.
2. Implement real Redis state store semantics or mark it explicitly as stub.
3. Complete PostgresStateStore persistence coverage + migrations.
4. Add JWT/auth gates and payload limits to demo API.
5. Harden webhook and filewatch security boundaries.
6. Improve external event error propagation contract.
7. Fill changelog and tools README completeness gaps.
