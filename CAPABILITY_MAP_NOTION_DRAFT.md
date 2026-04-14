# WeaveIntel + geneWeave Capability Map (Apr 2026)

## Executive Summary
WeaveIntel is a modular AI agent platform built as a monorepo, and geneWeave is its all-in-one server/runtime package that composes these capabilities into a deployable app (API, UI, admin, memory, observability, routing, and safety).

Core strengths:
- Provider-agnostic model runtime with OpenAI and Anthropic integrations
- Multi-mode execution: direct inference, tool-calling agents, and supervisor-worker orchestration
- Built-in tool ecosystem (time, search, utility, memory recall) with policy controls
- Enterprise tool ecosystem: 335+ MCP tools across Jira, ServiceNow, Canva, Confluence, Salesforce, Notion
- ServiceNow full API coverage: 283 tools spanning ITSM, CMDB, Service Catalog, Change/Problem/SLA, Security Ops, Analytics, DevOps, NLU, Admin, and ServiceNow Development/Configuration
- Persistent memory layers (conversation, semantic, entity) with hybrid extraction
- Governance stack: guardrails, redaction, routing policy, evals, compliance, identity, tenancy
- Production-grade operations: tracing, metrics/cost tracking, caching, workflows, replay/testing

## Package Capability Matrix
| Package | Key Capability |
| --- | --- |
| @weaveintel/core | Base contracts: ExecutionContext, models, tools, middleware, events |
| @weaveintel/agents | ReAct agents, supervisor orchestration, streaming steps |
| @weaveintel/models | Provider routing, capability-aware selection, fallback chains |
| @weaveintel/provider-openai | OpenAI model/embedding adapters |
| @weaveintel/provider-anthropic | Anthropic model/embedding adapters |
| @weaveintel/memory | Conversation, semantic, and entity memory primitives |
| @weaveintel/retrieval | Chunking, embedding pipelines, retrieval orchestration |
| @weaveintel/guardrails | Policy/risk evaluation and decisioning |
| @weaveintel/redaction | PII detection and redaction workflows |
| @weaveintel/routing | Cost/quality/health-based model routing |
| @weaveintel/observability | Tracing, metrics, run events |
| @weaveintel/evals | Eval cases, assertions, scoring |
| @weaveintel/tools | Generic tool registry and MCP-friendly tooling layer |
| @weaveintel/tools-time | Datetime/timezone, timers, stopwatches, reminders |
| @weaveintel/tools-search | Multi-provider web search tool routing |
| @weaveintel/tools-http | HTTP integration tools |
| @weaveintel/tools-browser | Browser automation tools |
| @weaveintel/tools-enterprise | Enterprise integrations — Jira (31 tools), ServiceNow (283 tools), Canva (21 tools), Confluence, Salesforce, Notion |
| @weaveintel/tools-social | Social platform tools |
| @weaveintel/mcp-server | MCP server implementation |
| @weaveintel/mcp-client | MCP client integration |
| @weaveintel/workflows | Workflow runtime with execution primitives |
| @weaveintel/a2a | Agent-to-agent communication contracts/runtime |
| @weaveintel/graph | Knowledge graph storage and retrieval primitives |
| @weaveintel/compliance | Compliance controls and policy handling |
| @weaveintel/human-tasks | Human-in-the-loop tasks and approvals |
| @weaveintel/cache | Response/cache primitives |
| @weaveintel/replay | Replay and deterministic re-execution support |
| @weaveintel/testing | Testing fakes/harnesses |
| @weaveintel/geneweave | Integrated app runtime (API + UI + Admin + persistence) |

## geneWeave Detailed Capabilities
### Runtime Modes
- direct: plain model inference, no tools
- agent: tool-calling autonomous loop with step traces
- supervisor: delegation to specialist workers with controlled tool access

### API and App Surface
- Auth endpoints with session handling
- Chat send + stream endpoints
- Admin CRUD endpoints for prompts, guardrails, routing, tools, memory governance, and more
- Dashboard/metrics endpoints
- Embedded UI and admin pages

### Memory System
- Conversation memory from chat history
- Semantic memory persisted in DB for long-term recall
- Entity memory persisted in DB for structured user facts
- Hybrid extraction pipeline (LLM-assisted + rule-based fallback)
- Memory extraction rules and events managed via admin capabilities
- memory_recall available as a default agent tool

### Tooling and Agent Control
- Tool registry with default policy by mode
- Temporal policy enforcement for time-sensitive tasks
- Built-in tools include datetime/timezone, timers, reminders, calculator, web search, JSON/text utilities, and memory recall
- Supervisor worker tool sets are configurable and include memory recall in defaults

### Safety, Governance, and Reliability
- Input/output guardrail checks with allow/warn/deny outcomes
- Redaction layer for sensitive content handling
- Routing policies for cost/quality/health-aware model selection
- Metrics and token/cost accounting
- Tracing and run diagnostics
- Configurable caching and policy checks

## Integration Architecture
System design pattern:
- @weaveintel/core defines portable abstractions
- Package capabilities compose into geneWeave runtime
- geneWeave provides HTTP + admin + persistence orchestration
- Cross-cutting services: memory, guardrails, routing, observability, compliance

## Notable Examples in Repository
- 01 simple chat
- 02 tool-calling agent
- 03 RAG pipeline
- 04 hierarchical agents
- 05 MCP integration
- 06 A2A communication
- 07 memory-augmented agent
- 08 PII redaction
- 09 eval suite
- 10 observability
- 11 anthropic provider
- 12 geneweave app
- 13 workflow engine
- 14 smart routing
- 15 tool ecosystem
- 16 human-in-the-loop
- 17 prompt management
- 18 knowledge graph
- 19 compliance sandbox
- 20 recipes/devtools

## Current Risks / Gaps (Observed)
- Some advanced admin surfaces may evolve faster than documentation
- Memory extraction confidence thresholds may benefit from stronger policy defaults
- Multi-instance distributed scaling concerns remain if SQLite is used without externalized stores
- Operational runbooks (rate limits, budget ceilings, alerting) should be standardized

## Recommended Next Documentation Additions
1. Create per-package capability docs with API signatures and examples
2. Add architecture decision records for routing, memory, and guardrails
3. Publish deployment profiles (local/dev/staging/prod) with explicit tradeoffs
4. Add an operations runbook for cost, safety, and incident response
