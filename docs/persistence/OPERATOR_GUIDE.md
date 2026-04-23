# Persistence Operator Guide

## Purpose
This guide is the Phase 9 operator runbook for persistence across weaveIntel runtimes.

It covers:
- backend selection by environment
- required environment variables
- startup validation checks
- backend-specific operations guidance
- incident triage for common persistence failures

## Supported Runtime Layers
The current persistence-related runtime entry points are:
- `@weaveintel/memory` via `createConfiguredMemoryStore()` and `createConfiguredConversationMemory()`
- `@weaveintel/persistence` via `createPhase7RuntimePersistence()` and `createPhase8PersistenceBenchmark()`
- `@weaveintel/live-agents` state-store backends used by examples and demo app

## Backend Matrix

| Backend | Primary use | Durability profile | Notes |
|---|---|---|---|
| `in-memory` | local tests/dev | process-bound only | resets on restart |
| `postgres` | durable system-of-record | strong durability/transactions | recommended for production durable state |
| `redis` | coordination cache and optional durable mode | mode-dependent | use `coordination-only` for claim/lease; use durable mode explicitly only when appropriate |
| `sqlite` | local single-node durable mode | file durability | enable WAL; avoid multi-process writes |
| `mongodb` | document persistence | durable per deployment config | enforce indexes and tenant scoping |
| `cloud-nosql` (dynamodb style) | managed cloud KV/document | conditional-write durability model | requires partition-key discipline |

## Environment Configuration

### Memory + Phase 7/8 shared backend settings
Use backend-specific options consumed by `@weaveintel/memory` and `@weaveintel/persistence`:
- `backend` values: `in-memory | postgres | redis | sqlite | mongodb | cloud-nosql`
- Postgres:
  - `postgresUrl`
- Redis:
  - `redisUrl`
  - `redisKeyPrefix` (recommended per environment)
- SQLite:
  - `sqlitePath`
- MongoDB:
  - `mongoUrl`
  - `mongoDatabaseName`
  - `mongoCollectionName`
- Cloud NoSQL (DynamoDB-style):
  - `cloudNoSqlProvider=dynamodb`
  - `dynamoDbEndpoint`
  - `dynamoDbRegion`
  - `dynamoDbTableName`

### Suggested env var convention
For app-level configuration, use these environment variables in your app wiring layer:
- `WEAVE_PERSISTENCE_BACKEND`
- `WEAVE_POSTGRES_URL`
- `WEAVE_REDIS_URL`
- `WEAVE_REDIS_KEY_PREFIX`
- `WEAVE_SQLITE_PATH`
- `WEAVE_MONGODB_URL`
- `WEAVE_MONGODB_DATABASE`
- `WEAVE_MONGODB_COLLECTION`
- `WEAVE_DYNAMODB_ENDPOINT`
- `WEAVE_DYNAMODB_REGION`
- `WEAVE_DYNAMODB_TABLE`

## Startup Validation Checklist

1. Verify backend selection is explicit in logs.
2. Verify runtime-level health checks pass.
3. Verify tenant/user/session metadata is present in writes.
4. Verify restart durability where expected:
   - expected durable backends should retain records after restart
   - in-memory should not be treated as durable
5. Verify environment-gated scenarios are clearly marked as skipped in CI logs.

## Backend-Specific Operational Guidance

### Postgres
- Keep schema migrations versioned and deployed before runtime rollout.
- Ensure connection pool settings match pod/container limits.
- Monitor lock wait and long-running query metrics.
- Keep idempotency keys and tenant selectors indexed.

### Redis
- Decide mode per deployment:
  - `coordination-only` for claim/lease correctness and speed
  - durable mode only when intentional and documented
- Use environment-specific key prefixes to avoid cross-environment bleed.
- Configure maxmemory and eviction policy intentionally; avoid accidental loss of durable-intended records.

### SQLite
- Use absolute file paths in service environments.
- Enable WAL mode for reliability under moderate write concurrency.
- Do not share one SQLite file across many writer processes.

### MongoDB
- Pre-create indexes for tenant + key fields.
- Keep collections bounded by lifecycle policies where applicable.
- Watch write concern and replication settings by environment.

### Cloud NoSQL (DynamoDB style)
- Define partition/sort key strategy around tenant and entity domains.
- Use conditional writes for idempotency and optimistic concurrency.
- Monitor throttling and retry behavior under load.

## Incident Triage

### Symptom: missing records after restart
- Confirm backend is not `in-memory`.
- Confirm persistence path/table/database name is stable across restarts.
- Confirm app is not writing to ephemeral temporary paths.

### Symptom: duplicate claims or lease races
- Validate claim path uses coordination-safe backend semantics.
- For Redis, confirm correct mode and atomic claim operations.
- Re-run concurrency scenario from [examples/60-live-agents-persistence-methods-e2e.ts](../../examples/60-live-agents-persistence-methods-e2e.ts).

### Symptom: high p95 latency
- Run [examples/63-phase8-persistence-performance-reliability-e2e.ts](../../examples/63-phase8-persistence-performance-reliability-e2e.ts).
- Compare to Phase 8 SLO targets in [docs/WEAVEAGENTS_MULTI_DB_PERSISTENCE_PLAN.md](../WEAVEAGENTS_MULTI_DB_PERSISTENCE_PLAN.md).
- Tune backend pool/connection/retry settings before increasing app-level concurrency.

## Release Validation Commands
Use this command set as an operator release gate:

1. `npm run typecheck --workspace @weaveintel/memory`
2. `npm run build --workspace @weaveintel/memory`
3. `npm run test --workspace @weaveintel/memory`
4. `npm run typecheck --workspace @weaveintel/persistence`
5. `npm run build --workspace @weaveintel/persistence`
6. `npm run test --workspace @weaveintel/persistence`
7. `node --import tsx examples/61-agent-persistence-methods-e2e.ts`
8. `node --import tsx examples/62-phase7-observability-replay-eval-persistence-e2e.ts`
9. `node --import tsx examples/63-phase8-persistence-performance-reliability-e2e.ts`
10. `node --import tsx examples/64-phase9-persistence-release-e2e.ts`

Service-backed scenarios are expected to print explicit skip messages when environment variables are not configured.
