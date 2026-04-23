# Persistence Backend E2E Examples

## Purpose
This document maps the persistence examples to backend capabilities and runtime layers.

## Example Catalog

### [examples/60-live-agents-persistence-methods-e2e.ts](../../examples/60-live-agents-persistence-methods-e2e.ts)
Covers live-agents state-store scenarios:
- in-memory baseline
- postgres durability
- redis coordination-only claim correctness
- redis durable-explicit restart durability
- sqlite local durability
- mongodb durability
- cloud-nosql (dynamodb-style) durability

### [examples/61-agent-persistence-methods-e2e.ts](../../examples/61-agent-persistence-methods-e2e.ts)
Covers non-live tool-calling agent memory scenarios:
- in-memory
- postgres
- redis
- sqlite
- mongodb
- cloud-nosql (dynamodb-style)

### [examples/62-phase7-observability-replay-eval-persistence-e2e.ts](../../examples/62-phase7-observability-replay-eval-persistence-e2e.ts)
Covers phase-7 shared runtime persistence:
- trace span persistence
- replay checkpoint persistence and retrieval
- eval suite metadata persistence
- restart durability where backend supports it

### [examples/63-phase8-persistence-performance-reliability-e2e.ts](../../examples/63-phase8-persistence-performance-reliability-e2e.ts)
Covers phase-8 performance and reliability benchmark:
- load (latency + throughput)
- failover close/reopen recovery
- chaos retry recovery accounting

### [examples/64-phase9-persistence-release-e2e.ts](../../examples/64-phase9-persistence-release-e2e.ts)
Phase-9 release validator that executes selected phase-6/7/8 examples and reports pass/fail summary.

## Environment Variables

### Live agents (Example 60)
- `LIVE_AGENTS_EXAMPLE_POSTGRES_URL`
- `LIVE_AGENTS_EXAMPLE_REDIS_URL`
- `LIVE_AGENTS_EXAMPLE_SQLITE_PATH`
- `LIVE_AGENTS_EXAMPLE_MONGODB_URL`
- `LIVE_AGENTS_EXAMPLE_MONGODB_DATABASE`
- `LIVE_AGENTS_EXAMPLE_DYNAMODB_ENDPOINT`
- `LIVE_AGENTS_EXAMPLE_DYNAMODB_REGION`
- `LIVE_AGENTS_EXAMPLE_DYNAMODB_TABLE`

### Agent memory + phase-7/8 examples (Examples 61-63)
- `WEAVE_AGENT_EXAMPLE_POSTGRES_URL`
- `WEAVE_AGENT_EXAMPLE_REDIS_URL`
- `WEAVE_AGENT_EXAMPLE_SQLITE_PATH`
- `WEAVE_AGENT_EXAMPLE_MONGODB_URL`
- `WEAVE_AGENT_EXAMPLE_MONGODB_DATABASE`
- `WEAVE_AGENT_EXAMPLE_DYNAMODB_ENDPOINT`
- `WEAVE_AGENT_EXAMPLE_DYNAMODB_REGION`
- `WEAVE_AGENT_EXAMPLE_DYNAMODB_TABLE`
- `WEAVE_PHASE7_EXAMPLE_POSTGRES_URL`
- `WEAVE_PHASE7_EXAMPLE_REDIS_URL`
- `WEAVE_PHASE7_EXAMPLE_SQLITE_PATH`
- `WEAVE_PHASE7_EXAMPLE_MONGODB_URL`
- `WEAVE_PHASE7_EXAMPLE_DYNAMODB_ENDPOINT`
- `WEAVE_PHASE8_EXAMPLE_POSTGRES_URL`
- `WEAVE_PHASE8_EXAMPLE_REDIS_URL`
- `WEAVE_PHASE8_EXAMPLE_SQLITE_PATH`
- `WEAVE_PHASE8_EXAMPLE_MONGODB_URL`
- `WEAVE_PHASE8_EXAMPLE_DYNAMODB_ENDPOINT`

## Recommended Execution Order

1. `node --import tsx examples/61-agent-persistence-methods-e2e.ts`
2. `node --import tsx examples/62-phase7-observability-replay-eval-persistence-e2e.ts`
3. `node --import tsx examples/63-phase8-persistence-performance-reliability-e2e.ts`
4. `node --import tsx examples/64-phase9-persistence-release-e2e.ts`

For live-agents deployments, run:
- `node --import tsx examples/60-live-agents-persistence-methods-e2e.ts`

## Pass/Skip Expectations
- In local environments without service backends configured, service-backed scenarios should report explicit `skipped` messages.
- In configured integration environments, all scenarios should pass with no unhandled errors.
