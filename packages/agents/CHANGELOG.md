# @weaveintel/agents

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
