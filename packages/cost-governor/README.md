# @weaveintel/cost-governor

Phase 1 of the WeaveIntel cost-control plan: **telemetry & cost ledger**.

This package is purely observational. It records every model and tool
invocation with token + USD + lever attribution so downstream phases can
measure savings against a real baseline. No behaviour change at this layer
— the ledger never blocks, never gates, and never throws into the hot path.

## What it gives you

- A typed `CostLedgerEntry` row format (run id, step id, agent id/role,
  source, lever, subject, tokens, $).
- `weaveCostLedger({ sink })` — user-facing factory backed by a pluggable
  `CostLedgerSink` (e.g. one that writes `live_run_events.kind = 'cost.tick'`).
- `wrapModelWithCostLedger(model, …)` — drops a thin wrapper around any
  `Model` so every `generate()` / completed `stream()` emits one ledger
  row from the provider's own `usage` block.
- `wrapAuditEmitterWithCostLedger(…)` — wraps a `ToolAuditEmitter` so
  every tool call also lands in the ledger as an inventory row (USD = 0
  in Phase 1, lever = `tool`).
- Pure helpers: `computeUsd(usage, rate)`, `aggregate(runId, entries)`.

## Levers

```ts
type CostLever = 'model' | 'tool' | 'rag' | 'reasoning' | 'cache' | 'other';
```

The model wrapper auto-attributes to `reasoning` when the response carries
`reasoningTokens > 0`, otherwise `model`. Apps can override per-call by
constructing entries directly.

## Failure model

- Sinks must not throw. Internal failures are swallowed.
- Pricing lookups failing → cost recorded as `$0`; the entry still lands.
- Missing `runId` on the resolved context → entry skipped (we never write
  orphan rows).

## Reference wiring

The reference consumer is `apps/geneweave`. The DB-backed sink writes one
row per entry into `live_run_events` with `kind = 'cost.tick'` and the
entry serialised in `payload_json`. The admin API aggregates those rows
into a per-run `CostBreakdown` for the operator UI.
