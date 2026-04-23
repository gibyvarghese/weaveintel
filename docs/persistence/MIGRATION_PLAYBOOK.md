# Persistence Migration Playbook

## Purpose
This playbook defines safe migration paths between persistence backends for weaveIntel runtimes.

It is designed for:
- moving from `in-memory` to durable storage
- changing durable backends (`sqlite -> postgres`, `redis durable -> postgres`, `mongodb -> cloud-nosql`, etc.)
- preserving tenant-scoped runtime data integrity during cutovers

## Core Migration Principles

1. Never cut over without a reversible rollback path.
2. Keep writes idempotent during dual-write windows.
3. Verify tenant scoping before and after migration.
4. Treat backend switch as an application release event with explicit validation.
5. Use replayable validation scripts and examples, not ad hoc manual checks.

## Pre-Migration Checklist

1. Inventory data domains in scope:
   - conversation memory
   - semantic/entity memory
   - Phase 7 traces/checkpoints/eval runs
   - live-agent state domains if applicable
2. Confirm source and target schema/table/collection names.
3. Confirm index strategy for target backend.
4. Define success metrics:
   - record count parity by tenant/domain
   - checksum/sample parity for key payload fields
   - no new error category spikes (`conflict`, `not-found`, `transient`, `fatal`)
5. Prepare rollback trigger conditions and owner contacts.

## Recommended Cutover Strategy

### Step 1: Readiness and dry-run
- Stand up target backend in staging.
- Run examples for source and target modes:
  - [examples/61-agent-persistence-methods-e2e.ts](../../examples/61-agent-persistence-methods-e2e.ts)
  - [examples/62-phase7-observability-replay-eval-persistence-e2e.ts](../../examples/62-phase7-observability-replay-eval-persistence-e2e.ts)
  - [examples/63-phase8-persistence-performance-reliability-e2e.ts](../../examples/63-phase8-persistence-performance-reliability-e2e.ts)

### Step 2: Backfill historical data
- Export source records by tenant/domain.
- Transform payload shape only when required by target backend constraints.
- Import in deterministic batches and preserve record ids when possible.

### Step 3: Dual-write window
- Enable writes to both source and target backends.
- Continue reads from source only.
- Monitor write parity and error deltas.

### Step 4: Shadow-read validation
- Keep production reads on source.
- Run shadow reads on target and compare payloads for a sample set.
- Validate latest checkpoint resolution and eval run listing behavior.

### Step 5: Read cutover
- Switch read path to target backend.
- Keep dual-write enabled for a short safety window.

### Step 6: Finalize
- Disable source writes.
- Archive source snapshot according to retention policy.
- Update runbooks and on-call documentation.

## Rollback Plan

Rollback should be immediate and scripted:
1. Switch read path back to source.
2. Keep target writes enabled only if needed for forensic comparison.
3. Disable dual-write if target is unstable.
4. Re-run release validation commands.
5. File a postmortem entry with failed checks and remediation actions.

## Backend-Specific Migration Notes

### in-memory -> durable backend
- No historical persistence unless externally exported.
- Treat as clean boot with explicit acceptance by stakeholders.

### sqlite -> postgres
- Ensure SQLite timestamps and ids preserve ordering semantics during import.
- Validate latest-checkpoint ordering after import using deterministic samples.

### redis durable -> postgres
- Confirm TTL settings did not expire data before migration.
- Export keyspace by prefix and map to normalized target shape.

### mongodb -> cloud-nosql
- Flatten nested documents where partition-key strategy requires it.
- Precompute tenant partition keys to avoid hot partitions.

## Validation Commands

1. `npm run typecheck --workspace @weaveintel/memory`
2. `npm run build --workspace @weaveintel/memory`
3. `npm run test --workspace @weaveintel/memory`
4. `npm run typecheck --workspace @weaveintel/persistence`
5. `npm run build --workspace @weaveintel/persistence`
6. `npm run test --workspace @weaveintel/persistence`
7. `node --import tsx examples/64-phase9-persistence-release-e2e.ts`

## Migration Sign-Off Template

Record these items in your release ticket:
- source backend
- target backend
- tenant scope
- dual-write window start/end
- parity summary (counts + sampled payload checks)
- failover/chaos benchmark summary
- rollback needed: yes/no
- operator approval names and timestamps
