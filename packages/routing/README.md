# @weaveintel/routing

**Picks the right model for each request using policy, live health tracking, and weighted scoring — with an explainable decision.**

## Why it exists

You often have several models that could answer a request — a cheap fast one, a big careful one, a vision one — and choosing by hand for every call doesn't scale. Think of it like a hospital triage nurse: they read what's in front of them, know which specialists are on shift and which are overloaded, and send you to the right one with a reason. `routing` is that nurse for models: it reads the request, filters out models that can't do the job, scores the rest on cost and quality, avoids ones that are currently failing, and tells you *why* it chose what it chose.

## When to reach for it

Reach for it when more than one model is a candidate and the choice should be automatic and auditable — cost ceilings, capability/modality constraints, fallback chains, health-aware avoidance of a flaky provider. If you always call the same single model, you don't need a router. The routing *contracts* (`ModelRouter`, `RoutingPolicy`, `RoutingDecision`) live in `@weaveintel/core`; this package is the implementation.

## How to use it

```ts
import { SmartModelRouter, ModelHealthTracker, ModelScorer } from '@weaveintel/routing';

const router = new SmartModelRouter({
  scorer: new ModelScorer(),
  health: new ModelHealthTracker(),
});

const decision = await router.route(
  { taskType: 'summarize', maxCostPer1kTokens: 0.5 },
  ['claude-model', 'fast-cheap-model', 'vision-model'],
);

console.log(decision.selectedModel, decision.reason);
```

## What's in the box

- **Router** — `SmartModelRouter` (the top-level decision maker).
- **Health** — `ModelHealthTracker` (records successes/failures to steer away from failing models).
- **Scoring** — `ModelScorer` weighs cost vs. quality vs. capability.
- **Policy helpers** — `filterByConstraints`, `filterByCapability`, `filterByModality`, `filterByCostCeiling`, `roundRobinSelect`, `fallbackChainCandidates`.
- **Task inference** — `inferTaskType` guesses the task from the request.
- **Capability flags** — `getModelCapabilityFlags`, `getModelContextWindowK`, `getModelMaxOutputK`.
- **Runtime slot & seeds** — `createRuntimeRoutingAdapter`, plus `DEFAULT_ROUTING_POLICIES`, `DEFAULT_MODEL_PRICING`, `DEFAULT_TASK_TYPES`.

- **Rule router** — `createRuleRouter({ targets, rules, dataRule })`: routes held as plain rows. A rule says "for this purpose (chat, agent, judge, summarise, embed) try these models in this order", with needs (capabilities, context size), a cost ceiling and a latency ceiling. A per-tenant data rule lists the providers and regions data may go to. `plan(request)` decides without calling anything and returns every candidate with the reason it was kept or dropped, plus one plain sentence. `run(request, attempt)` calls your function for the chosen model and moves to the next step when it fails, pausing a model that keeps failing (circuit breaker from `@weaveintel/resilience`). A request carrying an `affinityKey` stays with the model that answered first until that model fails. **An embedding route never falls back to a different model**: a step is usable only when it declares the same vector space as the first, and otherwise the request fails with a clear error.

Single entry point: `@weaveintel/routing`.

## License

MIT.
