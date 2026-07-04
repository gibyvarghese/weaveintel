# @weaveintel/triggers

**One dispatcher that connects "when this happens" to "then run that" — sources (cron, webhook, signal, event) wired to targets (workflow, agent tick, webhook) through DB-driven rules.**

## Why it exists

Plenty of work shouldn't wait for someone to sit on a chat tab and press go: kick a workflow every ten minutes, page on-call when severity turns high, start a follow-up job when an agent finishes its last one. Each of those is the same shape — something *happens*, a rule decides whether it counts, and if it does, something *runs*. Think of a building's alarm panel: sensors on one side, sirens and sprinklers on the other, and a wiring board in the middle saying "smoke in room 3 → sound floor-2 alarm." This package is that wiring board for your system. Each connection is a plain database row pairing a source with a target, with an optional filter and a rate limit.

## When to reach for it

Reach for `@weaveintel/triggers` when something must run *without a human initiating it* — on a schedule, on an event, on a signal. If you already know the exact sequence of steps to run once fired, that sequence belongs in `@weaveintel/workflows`; a trigger's job is only to *start* it. This package is pure and in-memory; the host app supplies DB-backed stores and app-level target adapters (or use the DB store adapters below).

## How to use it

```ts
import {
  createTriggerDispatcher,
  InMemoryTriggerStore,
  ManualSourceAdapter,
  CallbackTargetAdapter,
  type Trigger,
} from '@weaveintel/triggers';

const store = new InMemoryTriggerStore();
const dispatcher = createTriggerDispatcher({
  store,
  sourceAdapters: [new ManualSourceAdapter()],
  targetAdapters: [
    new CallbackTargetAdapter('workflow', async (target, input) => {
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

## What's in the box

| Export | What it does |
|---|---|
| `createTriggerDispatcher` | The core dispatcher: matches events to triggers, filters, rate-limits, and invokes targets. |
| `Trigger`, `SourceAdapter`, `TargetAdapter`, `TriggerStore` | The canonical types (from the dispatcher surface). |
| `ManualSourceAdapter`, `CronSourceAdapter`, `SignalBusSourceAdapter`, `MeshContractSourceAdapter` | Built-in event sources — admin/test fire, cron, signal bus, and workflow-contract emissions. |
| `WebhookOutTargetAdapter`, `CallbackTargetAdapter` | Built-in targets — POST JSON outbound, or wrap any async app-level action. |
| `InMemoryTriggerStore` | In-memory store for tests and examples. |
| `weaveSqliteTriggerStore`, `weavePostgresTriggerStore`, `weaveMongoDbTriggerStore`, `weaveRedisTriggerStore`, `weaveDynamoDbTriggerStore` | DB-backed stores, one per supported backend. |
| `createDurableTriggerRateLimiter` | Per-trigger rate-limit windows backed by durable KV. |
| `createReminderTrigger`, `rescheduleReminder`, `ReminderBusTargetAdapter` | Reminder ergonomics on top of triggers. |
| `isValidCron`, `cronMatches`, `cronNextRun`, `isValidTimezone` | Timezone-aware cron schedule evaluation. |
| `newRunBudget`, `chargeBudget`, `budgetExhausted` | Token + step ceilings to keep autonomous runs from running away. |

## License

MIT.
