# WeaveIntel Examples

This directory contains runnable TypeScript examples organized into three tiers.

## Folder structure

```
examples/
├── packages/      ← one-per-package, fully in-memory, no API keys needed
├── use-cases/     ← multi-package scenarios wired around a realistic problem
├── with-llm/      ← full-stack examples that call a real LLM (API key required)
└── *.ts           ← legacy numbered files (backward-compat, still runnable)
```

---

## `examples/packages/` — Package showcase examples

Each file demonstrates one `@weaveintel/*` package in isolation with no external
services and no API keys. This is the right starting point when you want to
understand what a single package does and how to configure it.

| File | Package | What it demonstrates |
|------|---------|----------------------|
| `resilience.ts` | `@weaveintel/resilience` | Token bucket, circuit breaker, retry, concurrency limiter, endpoint registry |
| `tenancy.ts` | `@weaveintel/tenancy` | Config override layers, entitlement gating, budget enforcement |
| `extraction.ts` | `@weaveintel/extraction` | Document transform pipeline, metadata/entity/code/task stages |
| `artifacts.ts` | `@weaveintel/artifacts` | Artifact CRUD, versioning, policy validation, reference resolution |
| `collaboration.ts` | `@weaveintel/collaboration` | Shared sessions, collaboration events, run subscriptions, handoff lifecycle |
| `plugins.ts` | `@weaveintel/plugins` | Manifest validation, registry, lifecycle hooks, installer |
| `tools-time.ts` | `@weaveintel/tools-time` | Time snapshot, formatting, timer/stopwatch state machines, tool schemas |
| `sqlite-e2e.ts` | `@weaveintel/skills` + `@weaveintel/memory` | SQLite-backed skills + memory (custom adapter pattern) |
| `encryption.ts` | `@weaveintel/encryption` | LocalKmsProvider, key hierarchy, AEAD envelope, field-level encryption, blind index |

Run any file with:

```bash
npx tsx examples/packages/<file>.ts
```

---

## `examples/use-cases/` — End-to-end scenario examples

These examples wire multiple packages together around a realistic use case.
They are still fully in-memory (no API keys, no external services) but show
how the packages compose.

| File | Use case | Packages used |
|------|----------|---------------|
| `research-assistant.ts` | AI research assistant with memory, routing, and caching | `@weaveintel/memory` · `@weaveintel/routing` · `@weaveintel/skills` · `@weaveintel/resilience` |
| `content-moderation.ts` | Content moderation pipeline with guardrails and artifacts | `@weaveintel/guardrails` · `@weaveintel/redaction` · `@weaveintel/artifacts` · `@weaveintel/observability` |
| `multi-tenant-saas.ts` | Multi-tenant platform with encryption, tenancy, and cost control | `@weaveintel/encryption` · `@weaveintel/tenancy` · `@weaveintel/cost-governor` |

Run any file with:

```bash
npx tsx examples/use-cases/<file>.ts
```

---

## `examples/with-llm/` — Real LLM examples

These examples connect to a real LLM (Anthropic Claude by default). They require
an API key in `ANTHROPIC_API_KEY` and make live API calls.

| File | What it demonstrates |
|------|----------------------|
| `anthropic-agent.ts` | Claude agent with tools, memory, routing, and resilience |

Set your key and run:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx tsx examples/with-llm/anthropic-agent.ts
```

---

## Legacy numbered files

The flat `*.ts` files at the root of `examples/` are retained for backward
compatibility. The `examples/packages/` files supersede them with better
organization, comments, and stub annotations.
