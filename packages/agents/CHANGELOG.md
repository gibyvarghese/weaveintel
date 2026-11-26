# @weaveintel/agents

## 0.3.1

### Patch Changes

- Updated dependencies [b29c076]
- Updated dependencies [b57835c]
  - @weaveintel/a2a@0.3.0
  - @weaveintel/core@0.3.1

## 0.3.0

### Minor Changes

- Swarms: a group of agents set to work on one task, driven by a definition that is plain data (`weaveSwarm`, also at the `@weaveintel/agents/swarm` subpath). Five patterns (plan/fan-out/join, map-reduce, pipeline, independent attempts with a judge, lead with helpers); hard limits on agents, steps, model calls, tokens, cost and time; failures reported, never hidden; worker output passed as fenced data with tool calls checked through the host's permission and approval ports; watch, cancel and resume through a `SwarmRunStore` port; `validateSwarmDefinition` and `estimateSwarm` for previewing a definition. Nothing existing changes.

## 0.2.2

### Patch Changes

- Updated dependencies
- Updated dependencies [7852b9b]
  - @weaveintel/core@0.3.0
  - @weaveintel/guardrails@0.2.2
  - @weaveintel/testing@0.1.3
  - @weaveintel/a2a@0.2.1
  - @weaveintel/cost-governor@0.2.2
  - @weaveintel/human-tasks@0.1.4
  - @weaveintel/memory@0.1.4
  - @weaveintel/prompts@0.2.4

## 0.2.1

### Patch Changes

- Updated dependencies [766246e]
- Updated dependencies [766246e]
  - @weaveintel/a2a@0.2.0
  - @weaveintel/core@0.2.0
  - @weaveintel/cost-governor@0.2.1
  - @weaveintel/guardrails@0.2.1
  - @weaveintel/human-tasks@0.1.3
  - @weaveintel/memory@0.1.3
  - @weaveintel/prompts@0.2.3
  - @weaveintel/testing@0.1.2

## 0.2.0

### Changed (fail-closed default)

- Tool results are quarantined before they re-enter the prompt (`toolResultQuarantine`, default on):
  each tool message is fenced with a per-run fence named in the system prompt, and a result from a tool
  that declares `schema.returns` must match it or it is withheld. `steps` keep the raw result (GAPS
  G-WI-2, platform-architecture §7.4 item 10).
- Structured output (`outputSchema`) is validated against the whole schema, not only required keys.

### Deprecated

- `createAclAwareRagApp`: its ACL lives only in prompt text. Emits a one-time `DeprecationWarning`
  (`WEAVEINTEL_ACL_RAG_PROMPT_ONLY`); enforce access in retrieval instead (G-WI-12, §7.4 item 5).
