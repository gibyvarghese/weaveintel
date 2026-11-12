# @weaveintel/routing

## 0.1.2

### Added

- **Rule router** (`createRuleRouter`): routes as plain data. Targets (provider and model, capabilities,
  context size, region, prices, typical latency, vector space) and rules (purpose, needs, cost and latency
  ceilings, sticky, ordered steps) may be functions, so a changed row applies on the next request. Each
  step is judged and the reason it was dropped is recorded: switched off, provider or region not allowed,
  missing capability, context too small, over the cost ceiling, too slow, paused after repeated failures.
  `run` fails over down the list, pauses a failing target with the resilience package's circuit breaker,
  and keeps one run on the target that answered it (`affinityKey`, scoped by tenant and rule).
- **Embedding safety**: the first embedding step fixes the route's vector space; a step in a different
  space is never used, and when nothing compatible is left the request fails rather than mixing vectors.
- Every decision carries its candidates as data and one plain sentence.

### Notes

- A request that is invalid, cancelled, blocked by policy or over budget is handed straight back and does
  not count against the model's health. Pass `shouldFailOver` to decide otherwise.
- The breaker keeps time with the system clock, and a target coming back from a pause admits every caller
  until one of them fails.
