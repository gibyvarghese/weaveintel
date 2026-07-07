# @weaveintel/human-tasks

**Pause an automated workflow to wait for a person's decision — approvals, reviews, and escalations — then resume once they've answered.**

## Why it exists

Some choices shouldn't be made by a machine alone: refunding a big charge, publishing to production, deleting a customer's data. This package lets an agent stop mid-flight and hand the decision to a human, the way a cashier calls a manager over for the void key. The work waits in a queue, someone claims it, decides, and the decision is recorded — so the agent picks up exactly where it left off, with an auditable trail of who approved what.

## When to reach for it

Reach for it when an agent or workflow needs a human gate — sign-off before a risky action, a review step before something ships, an escalation when confidence is low or an SLA is about to slip. If your step is fully autonomous and every outcome is safe to take without oversight, skip this and just run the step; a policy guardrail may be a lighter fit than a full human task.

## How to use it

```ts
import { createApprovalTask, InMemoryTaskQueue, createDecision } from '@weaveintel/human-tasks';

const queue = new InMemoryTaskQueue();

const task = createApprovalTask({
  title: 'Refund $840 to customer',
  action: 'issue_refund',
  context: { orderId: 'ord_123', amount: 840 },
  riskLevel: 'high',
});
const { id } = await queue.enqueue(task);

// ...a reviewer claims and decides...
const claimed = await queue.dequeue('reviewer@acme.com');
await queue.complete(id, createDecision(id, 'reviewer@acme.com', 'approve'));
```

## Store tasks in a real database (Postgres)

Tasks that a person needs to act on must not vanish on a restart, and — importantly — two workers must never be handed the *same* task. `createPostgresHumanTaskRepository` is the same `HumanTaskRepository` port backed by Postgres, built for exactly that. Hand it a `pg.Pool` (share one across your app — e.g. from `weaveSharedPostgres`); it creates its table on first use.

```ts
import pg from 'pg';
import { createPostgresHumanTaskRepository } from '@weaveintel/human-tasks';

const repo = createPostgresHumanTaskRepository({ pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }) });

await repo.save({ id: 't1', type: 'approval', title: 'Approve the refund', status: 'pending', priority: 'high', createdAt: new Date().toISOString() });

// A worker asks for the next thing to do — highest-priority, oldest first — and it's assigned to them alone.
const mine = await repo.claimNextPending('reviewer@acme.com');
```

The claim is the heart of it. It uses Postgres' `FOR UPDATE SKIP LOCKED` — the standard, race-free way to build a work queue on Postgres — so when a hundred workers ask for work at once, each gets a *different* task and none is ever double-claimed (a crashed worker's task simply returns to the pool). We prove this: 200 workers claiming 200 tasks concurrently, every task claimed exactly once.

The full task (including nested `data` and `provenance`) is stored as one JSON document so it round-trips exactly, while the fields you filter on (status, type, assignee, priority) are indexed columns for fast lookups. The same **contract test** runs against the in-memory, JSON-file, and Postgres versions, so they're guaranteed to behave the same:

```ts
import { humanTaskRepositoryContract, createPostgresHumanTaskRepository } from '@weaveintel/human-tasks';
humanTaskRepositoryContract(() => createPostgresHumanTaskRepository({ pool }), { describe, it, beforeEach, expect });
```

## What's in the box

- `createHumanTask`, `createApprovalTask`, `createReviewTask`, `createEscalationTask` — build a typed task for the decision you need.
- `InMemoryTaskQueue`, `RepositoryBackedTaskQueue` — enqueue, dequeue (claim), complete, and list tasks with SLA tracking.
- `InMemoryHumanTaskRepository`, `JsonFileHumanTaskRepository`, `createDurableHumanTaskRepository`, `createPostgresHumanTaskRepository` — where tasks live, from throwaway to durable Postgres storage (with race-free claiming).
- `humanTaskRepositoryContract` — the shared conformance test every repository adapter passes.
- `createDecision`, `DecisionLog` — record and audit who decided what, and when.
- `PolicyEvaluator`, `createPolicy` — decide automatically whether a task even needs a human.
- `createActionItem`, `completeActionItem`, `cancelActionItem` — track lightweight follow-up items.

## License

MIT.
