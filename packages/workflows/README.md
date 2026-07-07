# @weaveintel/workflows

**A workflow engine: define a task as a graph of steps, run it durably, and recover, compensate, or replay it when things go wrong.**

## Why it exists

Some jobs are too important to leave to a model improvising each move. "Take the payment, reserve the stock, email the receipt" has to happen in that order, exactly once each, and if the email fails you'd better be able to *undo* the reservation. That's a workflow: a fixed recipe of steps with retries, checkpoints, and cleanup built in. Think of a factory line rather than a chef winging it — each station does one thing, the belt records where every item is, and if a station jams you can rewind to the last checkpoint or run the line backwards to unwind. This package is that line: you `defineWorkflow`, the engine runs it, and the state is persisted at every step so a crash resumes instead of restarting.

## When to reach for it

Reach for `@weaveintel/workflows` when the sequence is known and you need it to be reliable, ordered, and auditable — payments, provisioning, multi-step ETL. If you instead want a model to *decide* the steps at runtime, use `@weaveintel/agents`. If you just need to *start* a workflow when something happens, that's `@weaveintel/triggers`. (Workflows and agents compose: a step can call an agent, and a workflow can emit a contract that triggers the next one.)

## How to use it

```ts
import { createWorkflowEngine, defineWorkflow, createHandlerResolverRegistry, createDefaultResolvers } from '@weaveintel/workflows';

const registry = createHandlerResolverRegistry();
for (const r of createDefaultResolvers()) registry.register(r);

const def = defineWorkflow('greet')
  .addStep({ id: 'hello', type: 'script', handler: 'script:return { greeting: "hi " + input.name }', next: null })
  .build();

const engine = createWorkflowEngine({ resolverRegistry: registry });
const run = await engine.startRun(def, { name: 'Ada' });
const finished = await engine.tickRun(run.id);

console.log(finished.status); // 'completed' | 'failed' | 'waiting' | ...
```

## What's in the box

| Export | What it does |
|---|---|
| `createWorkflowEngine` / `DefaultWorkflowEngine` | The engine: `startRun`, `tickRun`, persistence, optional contract emission. |
| `defineWorkflow` / `WorkflowBuilder` | Fluent builder for a step graph. |
| `createHandlerResolverRegistry`, `createDefaultResolvers` | Map a step's `kind` to how it runs — `noop`, `script`, `tool`, `prompt`, `agent`, `mcp`, `subworkflow`. |
| `createPlannerResolver` | Opt-in resolver that lets a step expand into a sub-graph at runtime (dynamic graphs). |
| `InMemoryScheduler` | Fire scheduled workflow runs. |
| `DefaultCompensationRegistry`, `runCompensations` | Register and run "undo" handlers when a run fails. |
| `InMemoryCheckpointStore`, `JsonFileCheckpointStore`, `createDurableCheckpointStore` | Snapshot run state so a crash resumes cleanly. |
| `WorkflowReplayRecorder`, `createReplayRegistry` | Record a run and replay it deterministically — no LLM calls, byte-identical output. |
| `validateWorkflowInput`, `InMemoryCostMeter`, `CircuitBreaker`, `Bulkhead`, `InMemoryRunQueue`, `InMemoryWorkflowRateLimiter` | Governance and resilience — input validation, cost ceilings, circuit breakers, bulkheads, queueing, rate limits. |
| `lintWorkflow`, `getWorkflowGraph`, `createWorkflowTestHarness` | Developer tooling — lint a definition, inspect its graph, test it with mock handlers. |
| `buildEmittedContract`, `ContractEmitter` | Publish a run's `outputContract` so downstream triggers or agents can react. |
| `weaveSqlite*`, `weavePostgres*`, `weaveMongoDb*`, `weaveRedis*`, `weaveDynamoDb*` stores | DB-backed adapters for checkpoints, definitions, runs, idempotency, payloads, sleep, locks, rate limits, queues, and audit — one set per backend. |

## One source of truth for SQL storage

The SQL adapters used to be written twice — once for Postgres, once for SQLite — and, like any copy, they slowly drifted apart (`$1` vs `?`, `jsonb` vs text, `NOW()` vs `CURRENT_TIMESTAMP`). That's now fixed for **all ten SQL-backed stores** — checkpoints, definitions, runs, idempotency, payloads, sleeps, step-locks, the run queue, rate limits, and the audit log. For each one, **the query logic is written once** with [Drizzle](https://orm.drizzle.team/) and reused for both databases. Every `weavePostgres*` / `weaveSqlite*` factory keeps the exact same API — they're just thin wrappers around one shared implementation now, so there's nothing left to drift.

Nothing changed for you as a caller:

```ts
import pg from 'pg';
import { weavePostgresCheckpointStore, weaveSqliteCheckpointStore } from '@weaveintel/workflows';

// Production: Postgres
const pgStore = await weavePostgresCheckpointStore({ pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }) });
// Edge / local / tests: SQLite — same behaviour, proven by the same tests
const liteStore = weaveSqliteCheckpointStore({ databasePath: './workflows.db' });

const cp = await pgStore.save('run-1', 'step-1', workflowState);
await pgStore.latest('run-1'); // resume from the newest checkpoint
```

There's exactly one place the two databases genuinely differ, and it's handled honestly: **draining the run queue.** Postgres uses `FOR UPDATE SKIP LOCKED` so a hundred workers can pull jobs in parallel without ever grabbing the same one; SQLite has a single writer so it doesn't need it. Everything else is identical.

How do we know both databases behave the same? The SQLite side is covered by the existing store tests, and the Postgres side runs the same operations against a real Postgres (Testcontainers) — including a 1,000-job concurrent queue drain where no job is ever handed out twice, and a durable "resume after a crash" where an agent checkpoints a real model's result to Postgres and a fresh process picks up exactly where it left off.

## License

MIT.
