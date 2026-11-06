# @weaveintel/workflows

## 0.1.4

### Patch Changes

- **A loop with a way out is no longer a lint error.** `lintWorkflow` used to report every cycle as the error
  `circular-reference`, although the engine runs bounded cycles (every run is capped by `policy.maxSteps`) and a
  rework loop ("ask again until the answer is usable") is an ordinary workflow shape. Cycles are now classified by
  strongly-connected component: one that a `next`, a switch case (`config.cases`) or an `onError` can leave is a
  `bounded-cycle` **warning**; one that no path can leave is still the `circular-reference` **error**. Found by
  geniWeave's flow validator (slice W1), which refuses only the inescapable loop.
