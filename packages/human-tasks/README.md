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

## What's in the box

- `createHumanTask`, `createApprovalTask`, `createReviewTask`, `createEscalationTask` — build a typed task for the decision you need.
- `InMemoryTaskQueue`, `RepositoryBackedTaskQueue` — enqueue, dequeue (claim), complete, and list tasks with SLA tracking.
- `InMemoryHumanTaskRepository`, `JsonFileHumanTaskRepository`, `createDurableHumanTaskRepository` — where tasks live, from throwaway to durable runtime-backed storage.
- `createDecision`, `DecisionLog` — record and audit who decided what, and when.
- `PolicyEvaluator`, `createPolicy` — decide automatically whether a task even needs a human.
- `createActionItem`, `completeActionItem`, `cancelActionItem` — track lightweight follow-up items.

## License

MIT.
