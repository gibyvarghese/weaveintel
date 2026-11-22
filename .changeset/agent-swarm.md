---
"@weaveintel/agents": minor
---

Swarms: a group of agents set to work on one task, driven by a definition that is plain data (`weaveSwarm`, also at the `@weaveintel/agents/swarm` subpath). Five patterns (plan/fan-out/join, map-reduce, pipeline, independent attempts with a judge, lead with helpers); hard limits on agents, steps, model calls, tokens, cost and time; failures reported, never hidden; worker output passed as fenced data with tool calls checked through the host's permission and approval ports; watch, cancel and resume through a `SwarmRunStore` port; `validateSwarmDefinition` and `estimateSwarm` for previewing a definition. Nothing existing changes.
