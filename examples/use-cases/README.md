# Use-case examples

Each example wires multiple `@weaveintel/*` packages together around a realistic
problem. All examples run fully in-memory — no API keys, no external services.

| File | Scenario | Packages |
|------|----------|---------|
| `multi-tenant-saas.ts` | Multi-tenant platform: feature gates, budget enforcement, PII encryption, cost tracking | `@weaveintel/tenancy` · `@weaveintel/encryption` · `@weaveintel/cost-governor` |
| `research-assistant.ts` | Resilient research assistant: memory, routing, and failure recovery | `@weaveintel/memory` · `@weaveintel/routing` · `@weaveintel/resilience` · `@weaveintel/artifacts` |

Run any file:

```bash
npx tsx examples/use-cases/multi-tenant-saas.ts
npx tsx examples/use-cases/research-assistant.ts
```
