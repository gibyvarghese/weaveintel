# @weaveintel/agents

## 0.2.1

### Added

- Swarms: a group of agents set to work on one task, driven by a definition that is plain data
  (`weaveSwarm`, also at the `@weaveintel/agents/swarm` subpath). One engine, five patterns chosen by
  the definition: plan, fan out and join; map over a list and reduce; a pipeline of stages; several
  independent attempts and a judge; a lead with helpers (the existing supervisor).
- Limits are enforced in code: agents, agents at once, steps per agent, model calls, tokens, cost and
  wall-clock time. On a limit the run stops cleanly and returns what it has, with the reason.
- Failure is reported, never hidden: one worker failing does not sink the run unless the definition
  says so, retries are bounded, and there is no fallback to a single agent.
- Safety: a worker's output reaches the next agent as fenced data; every tool call is checked through
  the host's permission port as the person who started the run; a write tool must be named in the
  definition and waits at the host's approval port.
- Watch, stop and resume: events on the core run-event contract, `cancel()`, and a store port
  (`SwarmRunStore`, in-memory by default) so a host can persist a run, mark it interrupted after a
  restart and carry it on without redoing finished work.
- `validateSwarmDefinition` and `estimateSwarm` for a host to check and preview a definition before
  starting it.

Nothing existing changes: the agent loop, supervisor, ensemble and verifier are untouched.

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
