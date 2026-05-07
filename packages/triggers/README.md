# @weaveintel/triggers

Unified trigger dispatcher — connects external sources (manual, webhook,
cron, signal-bus, MCP events, contract emitted, file change, …) to runtime
targets (workflow run, agent tick, mesh message, contract create, outbound
webhook, …) through one DB-driven dispatch path.

This package is **pure** — it ships only the in-memory pieces (interfaces,
filter language, rate limiter, manual/cron source adapters, webhook_out
target adapter, `InMemoryTriggerStore`). Persistence and DB-backed target
adapters are wired by the host app (see `apps/geneweave` for a SQLite +
workflow target reference implementation).

See [Phase 3 of the DB-Driven Capability Plan](../../docs/DB_DRIVEN_CAPABILITY_PLAN.md)
for the full design.

## When to use it

Add a trigger when a long-running thing needs to run **without anyone
sitting on the chat tab**. Common cases:

- "Every 10 minutes, kick this workflow."
- "When `incident.severity == 'high'`, post to PagerDuty webhook."
- "When agent X emits contract Y, start workflow Z."
- "On signal `release.cut`, fire a notification."

## Quick start

```ts
import {
  createTriggerDispatcher,
  InMemoryTriggerStore,
  ManualSourceAdapter,
  WebhookOutTargetAdapter,
  CallbackTargetAdapter,
  type Trigger,
} from '@weaveintel/triggers';

const store = new InMemoryTriggerStore();
const dispatcher = createTriggerDispatcher({
  store,
  sourceAdapters: [new ManualSourceAdapter()],
  targetAdapters: [
    new WebhookOutTargetAdapter(),
    new CallbackTargetAdapter('workflow', async (target, input) => {
      // Hand off to your workflow engine.
      console.log('start workflow', target.config['workflowDefId'], input);
      return { ref: 'wf-run-123' };
    }),
  ],
});

await store.save({
  id: 't-1',
  key: 'on-high-priority',
  enabled: true,
  source: { kind: 'manual', config: {} },
  filter: { expression: { '==': [{ var: 'payload.priority' }, 'high'] } },
  target: { kind: 'workflow', config: { workflowDefId: 'incident-triage' } },
  inputMap: { reason: 'payload.reason' },
  rateLimit: { perMinute: 5 },
} satisfies Trigger);

await dispatcher.start();
await dispatcher.dispatch({
  sourceKind: 'manual',
  payload: { priority: 'high', reason: 'pager' },
  observedAt: Date.now(),
});
```

A complete deterministic walkthrough lives in
[`examples/99-db-driven-triggers.ts`](../../examples/99-db-driven-triggers.ts).

## Concepts

### `Trigger`

A first-class DB row pairing a **source** with a **target**:

| Field          | Purpose                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------- |
| `source.kind`  | Discriminant (`manual`, `webhook`, `cron`, `signal_bus`, `mcp_event`, `contract_emitted`, `db_change`, `workflow_event`, `filewatch`). |
| `source.config`| Source-specific config (cron `intervalMs`, webhook `path`, etc.).                        |
| `filter`       | Optional JSONLogic-lite expression evaluated against `{ payload, meta }`.                |
| `target.kind`  | Discriminant (`workflow`, `agent_tick`, `mesh_message`, `contract`, `webhook_out`).      |
| `target.config`| Target-specific config (workflow id, webhook url + headers ref, …).                      |
| `inputMap`     | Dotted-path projection from event payload into target input.                             |
| `rateLimit`    | Per-trigger 1-minute tumbling window (`perMinute`).                                      |

### `SourceAdapter`

Streams events into the dispatcher. Built-ins:

- `ManualSourceAdapter` — for admin-fire and tests.
- `CronSourceAdapter` — used **internally** by the dispatcher; one
  instance is spun up per enabled cron trigger at `start()`.
- `SignalBusSourceAdapter` — bridges a `MinimalEventBus`.

External event sources (webhook ingress, filewatch, MCP, contract emit,
DB change) are wired by the host app. They typically just call
`dispatcher.dispatch(event)` directly — no adapter required.

### `TargetAdapter`

Acts on a fired trigger. Built-ins:

- `WebhookOutTargetAdapter` — POSTs JSON to `target.config.url` with
  optional headers (looked up from a credential resolver supplied by
  the host).
- `CallbackTargetAdapter` — wraps an arbitrary `async (target, input,
  meta) => { ref? }` for app-level targets (workflow, agent tick, …).

### Filter language

The expression DSL is intentionally tiny. Supported operators:

```
{ var: 'payload.priority' }
{ "==": [a, b] }   { "!=": [a, b] }
{ ">": [a, b] }    { ">=": [a, b] }
{ "<": [a, b] }    { "<=": [a, b] }
{ "and": [...] }   { "or": [...] }   { "!": expr }
{ "in": [needle, haystack] }
```

Unknown operators fail **closed** (treated as `false`).

### Rate limiting

Per trigger, a 1-minute tumbling window. When exceeded the dispatch is
recorded as `rate_limited` and the target is **not** invoked.

### Invocation audit ledger

Every dispatch produces a `TriggerInvocation` with one of these statuses:

`dispatched | filtered | rate_limited | disabled | no_target_adapter | error`

The host app wires this to a DB-backed `TriggerStore` so the operator
admin UI can list / filter past invocations.

## Host integration contract

The host (e.g. `apps/geneweave`) supplies:

1. A DB-backed `TriggerStore` over its own row tables.
2. App-level target adapters (workflow runner, agent tick scheduler,
   mesh message bus, contract creator).
3. A credential resolver for outbound webhook secrets.
4. Admin CRUD routes that call `dispatcher.reload()` after every write.

Manual fire from the admin UI passes `{ onlyTriggerId }` to bypass the
source kind filter:

```ts
await dispatcher.dispatch(
  { sourceKind: 'manual', payload, observedAt: Date.now() },
  { onlyTriggerId: id },
);
```

> Note: today the dispatcher also requires `t.source.kind === event.sourceKind`
> for candidate matching, so a "fire now" admin button works only on
> triggers whose source kind is `manual`. To force-run a non-manual trigger
> from admin, set its source kind to `manual` for testing or extend the
> dispatcher to bypass the source filter when `onlyTriggerId` is set.

## `MeshContractSourceAdapter` (Phase 4 — Mesh ↔ workflow binding)

`MeshContractSourceAdapter` consumes a Node `EventEmitter` and re-emits
`contract_emitted` trigger events whenever a workflow publishes its
`outputContract` (see `@weaveintel/workflows`). This closes the loop
between workflow output and downstream workflow / agent / webhook input.

```ts
import { EventEmitter } from 'node:events';
import { MeshContractSourceAdapter, createTriggerDispatcher } from '@weaveintel/triggers';

const bus = new EventEmitter();
const dispatcher = createTriggerDispatcher({
  store,
  sourceAdapters: [new MeshContractSourceAdapter(bus)],
  targetAdapters: [/* ... */],
});

// Anywhere a workflow ContractEmitter publishes:
bus.emit('mesh.contract', {
  id: 'c-123',
  kind: 'order.fulfilled',
  body: { orderId: 'O-1', amount: 42.5 },
  meta: { workflowDefinitionId: 'wf-...', workflowRunId: '...' },
});
```

The adapter wraps the bus payload as `{ sourceKind: 'contract_emitted', payload }`
so triggers can filter on `payload.kind`, `payload.body.*`, `payload.meta.*`.

> The bus MUST be a fresh `EventEmitter` constructed at app boot — never
> use module-level state. Geneweave constructs the bus in `index.ts` and
> hands it to both `DbContractEmitter` (publisher) and `MeshContractSourceAdapter`
> (consumer).

## See also

- [`apps/geneweave`](../../apps/geneweave) — DB-backed `TriggerStore`,
  workflow target adapter, admin CRUD at `/api/admin/triggers` + audit
  ledger at `/api/admin/trigger-invocations`.
- [`examples/99-db-driven-triggers.ts`](../../examples/99-db-driven-triggers.ts)
  — deterministic in-memory walkthrough.
- [`examples/100-mesh-workflow-binding.ts`](../../examples/100-mesh-workflow-binding.ts)
  — workflow → contract → trigger → workflow cascade end-to-end.
