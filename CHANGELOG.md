# Changelog

All notable changes to weaveIntel will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Fabric Versioning](VERSIONING.md).

---

## [1.0.0] — Aertex — 2026-04-12

First stable release of weaveIntel.

### Core Framework
- **@weaveintel/core** — Contracts, types, context, events, middleware, capability system, plugin registry
- **@weaveintel/models** — Unified model router with fallback chains, streaming, middleware, capability-based selection
- **@weaveintel/provider-openai** — OpenAI adapter — chat, streaming, embeddings, image, audio, structured output, vision, files, fine-tuning, batches, responses API
- **@weaveintel/provider-anthropic** — Anthropic adapter — chat, streaming, tool use, extended thinking, vision, token counting, batches, computer use, prompt caching
- **@weaveintel/testing** — Fake models, embeddings, vector stores, and MCP transports for deterministic tests

### Agent Orchestration
- **@weaveintel/agents** — Agent runtime with ReAct tool-calling loop and supervisor-worker hierarchies
- **@weaveintel/workflows** — Multi-step workflow engine with conditional branching, checkpointing, and compensation
- **@weaveintel/human-tasks** — Human-in-the-loop approval tasks, review queues, escalation, decision logging
- **@weaveintel/contracts** — Completion contracts with evidence bundles and completion reports
- **@weaveintel/prompts** — Versioned prompt templates, A/B experiments, instruction bundles
- **@weaveintel/routing** — Smart model routing — health tracking, capability matching, weighted scoring

### Knowledge & Retrieval
- **@weaveintel/retrieval** — Document chunking (6 strategies), embedding pipeline, vector retrieval with reranking
- **@weaveintel/memory** — Conversation, semantic, and entity memory implementations
- **@weaveintel/graph** — Knowledge graph with entity linking, timeline, and graph-based retrieval
- **@weaveintel/extraction** — Document extraction pipeline — entity, metadata, timeline, table, code, task stages
- **@weaveintel/cache** — Semantic caching with TTL, LRU eviction, and embedding-based lookup
- **@weaveintel/artifacts** — Artifact storage — versioned blobs with metadata, tagging, lifecycle management

### Tools & Connectivity
- **@weaveintel/tools** — Extended tool registry with versioning, risk tagging, health tracking
- **@weaveintel/tools-search** — Web search tools (DuckDuckGo, Brave)
- **@weaveintel/tools-browser** — Browser tools for URL fetching and content extraction
- **@weaveintel/tools-http** — HTTP endpoint tools with auth and rate limiting
- **@weaveintel/tools-enterprise** — Enterprise connectors (Jira, Slack, GitHub, database)
- **@weaveintel/tools-social** — Social media tools (Twitter/X, LinkedIn)
- **@weaveintel/mcp-client** — MCP protocol client for remote tool/resource/prompt discovery
- **@weaveintel/mcp-server** — MCP protocol server to expose tools, resources, and prompts
- **@weaveintel/a2a** — Agent-to-agent protocol (remote HTTP + in-process bus)
- **@weaveintel/plugins** — Plugin lifecycle — register, enable/disable, validate, dependency resolution

### Safety & Governance
- **@weaveintel/guardrails** — Guardrail pipeline with risk classification and cost guards
- **@weaveintel/redaction** — PII detection (email, phone, SSN, CC), reversible tokenization
- **@weaveintel/compliance** — Data retention, GDPR/CCPA deletion, legal holds, consent management
- **@weaveintel/sandbox** — Sandboxed execution with policy enforcement and resource limits
- **@weaveintel/identity** — Identity management — delegation chains, ACL enforcement
- **@weaveintel/tenancy** — Multi-tenancy with tenant isolation and budget management
- **@weaveintel/reliability** — Idempotency, retry budgets, dead-letter queues, health checking

### Observability & Evaluation
- **@weaveintel/observability** — Tracing, spans, event bus, cost/token usage tracking
- **@weaveintel/evals** — Evaluation runner with 6 assertion types
- **@weaveintel/replay** — Trace replay for debugging and regression testing

### Application Layer
- **@weaveintel/recipes** — Pre-built agent factories (governed assistant, approval-driven, workflow)
- **@weaveintel/devtools** — Developer tools for scaffolding, inspection, validation
- **@weaveintel/ui-primitives** — UI streaming events, widgets, artifacts, citations, progress
- **@weaveintel/triggers** — Trigger system (cron, webhooks, queue-based)
- **@weaveintel/collaboration** — Multi-user session management and agent collaboration
- **@weaveintel/geneweave** — Full-stack demo app with chat UI, admin dashboard, model pricing sync

### Examples
- 20 runnable examples covering simple chat, tool calling, RAG, hierarchical agents, MCP, A2A, memory, PII redaction, evaluations, observability, Anthropic provider, and geneWeave

---

[1.0.0]: https://github.com/gibyvarghese/weaveintel/releases/tag/v1.0.0
