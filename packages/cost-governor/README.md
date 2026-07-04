# @weaveintel/cost-governor

**Keeps LLM spend inside a budget: records what every model and tool call costs, and applies limits, cascades, and caps before the bill runs away.**

## Why it exists

Token costs are invisible until the invoice arrives. One runaway agent that loops a few extra times, or quietly picks the expensive model for a trivial question, can turn a cheap task into a costly one — and you won't know until it's spent. Think of it like a prepaid phone plan: every call is metered against a balance, cheaper options get used when they'll do, and when the balance runs out the next call is stopped rather than silently overrunning. This package is that meter and that balance for your model traffic.

## When to reach for it

Reach for it when you need to cap spend per run or per tenant, attribute cost to specific levers (model, tools, RAG, reasoning), or automatically downshift to cheaper models under budget pressure. If you need to block *unsafe* content rather than *expensive* calls, that's `@weaveintel/guardrails`; if you need retries and circuit breakers, that's `@weaveintel/resilience`.

## How to use it

```ts
import { weaveCostLedger, wrapModelWithCostLedger } from '@weaveintel/cost-governor';

const ledger = weaveCostLedger({ sink: myCostSink });
const metered = wrapModelWithCostLedger(model, { ledger, runId: 'run-123' });

// every generate()/stream() now emits one cost row from the provider's usage block
const reply = await metered.generate({ messages });
```

## What's in the box

- Ledger: `weaveCostLedger`, `createInMemoryCostLedger`, `wrapModelWithCostLedger`, `wrapAuditEmitterWithCostLedger`; helpers `computeUsd`, `aggregate`.
- Policy & budgets: `resolveCostPolicy`, `TIER_PRESETS`, `weaveCostGovernor`, `weaveBudgetGate`, `CostCeilingExceededError`.
- Spend-reducing levers: model cascade (`weaveModelCascadeResolver`), dynamic tool subset (`weaveToolSubsetFilter`, `weaveIntentRagToolSubsetFilter`), prompt caching (`weavePromptCachingShaper`), history compaction (`weaveHistoryCompactor`), reasoning effort (`wrapModelWithReasoningEffort`), tool-output truncation (`weaveToolOutputTruncator`), max-steps (`decideMaxSteps`).
- Durable variants: `createDurableCostLedger`, `createDurableRunCostStateTracker`.

Store subpaths (each pulls in an optional peer driver):

- `@weaveintel/cost-governor/sqlite`, `/postgres`, `/mongodb`, `/redis`, `/dynamodb` — persist the ledger in your database.

## License

MIT.
