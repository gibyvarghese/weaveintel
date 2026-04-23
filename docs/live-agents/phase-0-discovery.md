# Phase 0 Discovery: live-agents

Status: Complete
Date: 2026-04-23
Scope: Mandatory discovery from docs/liveagent.md Section 1

## 1) Package Summaries (with citations)

### Core framework packages

- @weaveintel/core
  - Provides execution envelope primitives (ExecutionContext, budget, deadline/cancellation helpers) and MCP contracts (client/server/tool/resource/prompt/transport types), which is the correct foundation for live-agents runtime context propagation and MCP-first external access. Sources: [packages/core/src/context.ts](../../packages/core/src/context.ts#L11), [packages/core/src/context.ts](../../packages/core/src/context.ts#L40), [packages/core/src/mcp.ts](../../packages/core/src/mcp.ts#L11), [packages/core/src/mcp.ts](../../packages/core/src/mcp.ts#L70), [packages/core/src/index.ts](../../packages/core/src/index.ts#L6), [packages/core/package.json](../../packages/core/package.json#L1).

- @weaveintel/agents
  - Exposes weaveAgent and weaveSupervisor as orchestration primitives; no persistence concerns are embedded in package surface, aligning with package-level in-memory framework boundaries. Sources: [packages/agents/src/index.ts](../../packages/agents/src/index.ts#L1), [packages/agents/package.json](../../packages/agents/package.json#L1), [packages/agents/README.md](../../packages/agents/README.md#L1).

- @weaveintel/a2a
  - Exposes weaveA2AClient and weaveA2ABus as async inter-agent communication primitives, making it the right collaboration substrate for asynchronous live-agent message exchange. Sources: [packages/a2a/src/index.ts](../../packages/a2a/src/index.ts#L1), [packages/a2a/package.json](../../packages/a2a/package.json#L1), [packages/a2a/README.md](../../packages/a2a/README.md#L1).

- @weaveintel/memory
  - Current package provides conversation, semantic, and entity memory via in-memory stores and interfaces; this is where the new working memory kind and compressor toolkit should be added per Phase 0 requirements. Sources: [packages/memory/src/index.ts](../../packages/memory/src/index.ts#L1), [packages/memory/src/memory.ts](../../packages/memory/src/memory.ts#L11), [packages/memory/src/memory.ts](../../packages/memory/src/memory.ts#L93), [packages/memory/src/memory.ts](../../packages/memory/src/memory.ts#L144), [packages/memory/package.json](../../packages/memory/package.json#L1), [packages/memory/README.md](../../packages/memory/README.md#L1).

- @weaveintel/mcp-client
  - Client is session/transport based: connect initializes JSON-RPC handshake, listTools/listResources/listPrompts discover runtime capability, and callTool forwards ExecutionContext in _meta.executionContext. This is the concrete entrypoint for account-bound MCP sessions in live-agents. Sources: [packages/mcp-client/src/client.ts](../../packages/mcp-client/src/client.ts#L38), [packages/mcp-client/src/client.ts](../../packages/mcp-client/src/client.ts#L74), [packages/mcp-client/src/client.ts](../../packages/mcp-client/src/client.ts#L82), [packages/mcp-client/src/client.ts](../../packages/mcp-client/src/client.ts#L134), [packages/mcp-client/src/client.test.ts](../../packages/mcp-client/src/client.test.ts#L1), [packages/mcp-client/package.json](../../packages/mcp-client/package.json#L1), [packages/mcp-client/README.md](../../packages/mcp-client/README.md#L1).

- @weaveintel/mcp-server
  - Server supports addTool/addResource/addPrompt and optional contextFactory for per-request ExecutionContext creation from JSON-RPC params; this is the existing pattern for identity propagation into tool handlers. Sources: [packages/mcp-server/src/server.ts](../../packages/mcp-server/src/server.ts#L43), [packages/mcp-server/src/server.ts](../../packages/mcp-server/src/server.ts#L86), [packages/mcp-server/src/server.ts](../../packages/mcp-server/src/server.ts#L145), [packages/mcp-server/src/index.ts](../../packages/mcp-server/src/index.ts#L1), [packages/mcp-server/package.json](../../packages/mcp-server/package.json#L1), [packages/mcp-server/README.md](../../packages/mcp-server/README.md#L1).

- @weaveintel/triggers
  - Exports cron/webhook/queue/change/binding trigger modules from package API, indicating scheduling/event bindings are framework abstractions while execution backends are app-owned. Sources: [packages/triggers/src/index.ts](../../packages/triggers/src/index.ts#L1), [packages/triggers/package.json](../../packages/triggers/package.json#L1).

- @weaveintel/workflows
  - Exposes workflow engine, state, scheduler, compensation, checkpoint store, and run repositories (in-memory and JSON-file), matching a package-first interface with pluggable persistence pattern. Sources: [packages/workflows/src/index.ts](../../packages/workflows/src/index.ts#L6), [packages/workflows/src/index.ts](../../packages/workflows/src/index.ts#L29), [packages/workflows/src/index.ts](../../packages/workflows/src/index.ts#L32), [packages/workflows/src/workflows.test.ts](../../packages/workflows/src/workflows.test.ts#L1), [packages/workflows/package.json](../../packages/workflows/package.json#L1).

- @weaveintel/human-tasks
  - Provides task factories, queues, repositories, decision log, and policy evaluator, with repository-backed queue options that map cleanly to live-agents approval/escalation flows. Sources: [packages/human-tasks/src/index.ts](../../packages/human-tasks/src/index.ts#L6), [packages/human-tasks/src/index.ts](../../packages/human-tasks/src/index.ts#L18), [packages/human-tasks/src/index.ts](../../packages/human-tasks/src/index.ts#L25), [packages/human-tasks/src/__tests__/human-tasks.test.ts](../../packages/human-tasks/src/__tests__/human-tasks.test.ts#L1), [packages/human-tasks/package.json](../../packages/human-tasks/package.json#L1).

- @weaveintel/contracts
  - Exposes contract builders/validators/evidence report helpers and remains the right ledger for completion evidence contracts used by autonomous agent workflows. Sources: [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts#L5), [packages/contracts/src/__tests__/contracts.test.ts](../../packages/contracts/src/__tests__/contracts.test.ts#L1), [packages/contracts/package.json](../../packages/contracts/package.json#L1).

- @weaveintel/prompts
  - Exposes rendering, linting, fragments, strategies, and execution helpers from one package entry; this remains the canonical prompt composition path for attention/action policy templates. Sources: [packages/prompts/src/index.ts](../../packages/prompts/src/index.ts#L6), [packages/prompts/src/index.ts](../../packages/prompts/src/index.ts#L68), [packages/prompts/src/index.ts](../../packages/prompts/src/index.ts#L130), [packages/prompts/src/prompts.test.ts](../../packages/prompts/src/prompts.test.ts#L1), [packages/prompts/package.json](../../packages/prompts/package.json#L1).

- @weaveintel/routing
  - Exposes model router, health tracker, scorer, and decision store for capability-aware model selection and fallback orchestration. Sources: [packages/routing/src/index.ts](../../packages/routing/src/index.ts#L6), [packages/routing/src/index.ts](../../packages/routing/src/index.ts#L10), [packages/routing/src/routing.test.ts](../../packages/routing/src/routing.test.ts#L1), [packages/routing/package.json](../../packages/routing/package.json#L1).

- @weaveintel/observability
  - Exposes tracer and usage/budget/timeline/graph sinks; this is the correct package for live-agent activity logging and replay trace breadcrumbs. Sources: [packages/observability/src/index.ts](../../packages/observability/src/index.ts#L1), [packages/observability/src/index.ts](../../packages/observability/src/index.ts#L13), [packages/observability/src/capability-telemetry.test.ts](../../packages/observability/src/capability-telemetry.test.ts#L1), [packages/observability/package.json](../../packages/observability/package.json#L1), [packages/observability/README.md](../../packages/observability/README.md#L1).

- @weaveintel/reliability
  - Exposes idempotency, retry budget, DLQ, concurrency and backpressure modules that can be reused in heartbeat/event processing. Sources: [packages/reliability/src/index.ts](../../packages/reliability/src/index.ts#L1), [packages/reliability/src/idempotency.test.ts](../../packages/reliability/src/idempotency.test.ts#L1), [packages/reliability/package.json](../../packages/reliability/package.json#L1).

- @weaveintel/tenancy
  - Exposes tenancy config/resolver/policy/capability-map/budget modules and should be used for mesh/agent tenant scoping. Sources: [packages/tenancy/src/index.ts](../../packages/tenancy/src/index.ts#L1), [packages/tenancy/package.json](../../packages/tenancy/package.json#L1).

- @weaveintel/identity
  - Provides runtime identity context creation and helper identities, and currently includes in-memory token resolver export in package index; suitable for account credential reference integration at app boundary. Sources: [packages/identity/src/context.ts](../../packages/identity/src/context.ts#L8), [packages/identity/src/context.ts](../../packages/identity/src/context.ts#L35), [packages/identity/src/index.ts](../../packages/identity/src/index.ts#L38), [packages/identity/src/identity.test.ts](../../packages/identity/src/identity.test.ts#L1), [packages/identity/package.json](../../packages/identity/package.json#L1).

- @weaveintel/recipes
  - Provides factory composition recipes for workflow/governed/approval/event patterns and is the right place to add live-agent composition recipes after base primitives exist. Sources: [packages/recipes/src/index.ts](../../packages/recipes/src/index.ts#L2), [packages/recipes/src/index.ts](../../packages/recipes/src/index.ts#L11), [packages/recipes/src/recipes.test.ts](../../packages/recipes/src/recipes.test.ts#L1), [packages/recipes/package.json](../../packages/recipes/package.json#L1).

- @weaveintel/devtools
  - Exposes scaffolding, validators, inspectors and mock runtime helpers, which can host live-agent project templates later. Sources: [packages/devtools/src/index.ts](../../packages/devtools/src/index.ts#L2), [packages/devtools/src/index.ts](../../packages/devtools/src/index.ts#L36), [packages/devtools/package.json](../../packages/devtools/package.json#L1).

- @weaveintel/ui-primitives
  - Exposes structured UI event builders for streaming views and can be reused by the demo app dashboard. Sources: [packages/ui-primitives/src/index.ts](../../packages/ui-primitives/src/index.ts#L2), [packages/ui-primitives/src/index.ts](../../packages/ui-primitives/src/index.ts#L40), [packages/ui-primitives/package.json](../../packages/ui-primitives/package.json#L1).

- @weaveintel/sandbox
  - Exposes sandbox policy/limits/result and container executor exports, suitable for high-risk code execution in live-agent skill tasks. Sources: [packages/sandbox/src/index.ts](../../packages/sandbox/src/index.ts#L1), [packages/sandbox/src/index.ts](../../packages/sandbox/src/index.ts#L7), [packages/sandbox/src/executors/container/container-executor.test.ts](../../packages/sandbox/src/executors/container/container-executor.test.ts#L1), [packages/sandbox/package.json](../../packages/sandbox/package.json#L1).

- @weaveintel/evals
  - Exposes eval runner plus rubric score utilities for KPI/evaluation hooks in autonomous operations. Sources: [packages/evals/src/index.ts](../../packages/evals/src/index.ts#L1), [packages/evals/package.json](../../packages/evals/package.json#L1), [packages/evals/README.md](../../packages/evals/README.md#L1).

- @weaveintel/replay
  - Exposes replay engine/scenario/golden/comparison/regression modules, appropriate for deterministic day replay of agent actions. Sources: [packages/replay/src/index.ts](../../packages/replay/src/index.ts#L1), [packages/replay/package.json](../../packages/replay/package.json#L1).

- @weaveintel/graph
  - Exposes graph memory primitives (nodes/edges/linker/timeline/retriever) that can back graph-based compression. Sources: [packages/graph/src/index.ts](../../packages/graph/src/index.ts#L2), [packages/graph/src/index.ts](../../packages/graph/src/index.ts#L20), [packages/graph/package.json](../../packages/graph/package.json#L1).

- @weaveintel/retrieval
  - Exposes chunking/embedding/retriever plus hybrid/query-rewriter/citations/diagnostics; useful for retrieval-based compression and handoff packet assembly. Sources: [packages/retrieval/src/index.ts](../../packages/retrieval/src/index.ts#L1), [packages/retrieval/src/index.ts](../../packages/retrieval/src/index.ts#L10), [packages/retrieval/package.json](../../packages/retrieval/package.json#L1), [packages/retrieval/README.md](../../packages/retrieval/README.md#L1).

- @weaveintel/testing
  - Exposes fake model/embedding/vector/transport/runtime tools for pure-node examples and deterministic tests, including MCP fake transport usage. Sources: [packages/testing/src/index.ts](../../packages/testing/src/index.ts#L1), [packages/testing/package.json](../../packages/testing/package.json#L1), [packages/testing/README.md](../../packages/testing/README.md#L1).

### Tools platform and tools-* packages

- @weaveintel/tools
  - Provides policy/audit/rate-limit/approval gate wrappers and risk-level enforcement around tool invocation; this is the canonical runtime guardrail layer for external action records. Sources: [packages/tools/src/policy.ts](../../packages/tools/src/policy.ts#L27), [packages/tools/src/policy.ts](../../packages/tools/src/policy.ts#L49), [packages/tools/src/policy.ts](../../packages/tools/src/policy.ts#L167), [packages/tools/package.json](../../packages/tools/package.json#L1).

- tools-social / tools-enterprise
  - Both packages expose large operation catalogs with schema-defined tool arguments and MCP-oriented naming patterns, proving existing one-package-many-operations composition that live-agents can consume through MCP sessions. Sources: [packages/tools-social/src/mcp.ts](../../packages/tools-social/src/mcp.ts#L1), [packages/tools-social/src/mcp.ts](../../packages/tools-social/src/mcp.ts#L187), [packages/tools-social/src/__tests__/mcp-factory.test.ts](../../packages/tools-social/src/__tests__/mcp-factory.test.ts#L1), [packages/tools-enterprise/src/mcp.ts](../../packages/tools-enterprise/src/mcp.ts#L1), [packages/tools-enterprise/src/mcp.ts](../../packages/tools-enterprise/src/mcp.ts#L84), [packages/tools-enterprise/src/__tests__/mcp-factory.test.ts](../../packages/tools-enterprise/src/__tests__/mcp-factory.test.ts#L1).

- tools-time
  - Provides deterministic in-memory temporal store and time tools with scoped state; useful as a model for stateful tool behavior without package-level DB dependencies. Sources: [packages/tools-time/src/index.ts](../../packages/tools-time/src/index.ts#L54), [packages/tools-time/src/index.ts](../../packages/tools-time/src/index.ts#L119), [packages/tools-time/src/time-tools.test.ts](../../packages/tools-time/src/time-tools.test.ts#L1).

- tools-browser / tools-http / tools-search
  - These packages are present as exported tool packages in GeneWeave dependencies and package manifests, aligning with modular tool package boundaries. Sources: [apps/geneweave/package.json](../../apps/geneweave/package.json#L43), [packages/tools-browser/package.json](../../packages/tools-browser/package.json#L1), [packages/tools-http/package.json](../../packages/tools-http/package.json#L1), [packages/tools-search/package.json](../../packages/tools-search/package.json#L1).

## 2) MCP specifics confirmed

- Authentication and identity propagation
  - MCP server supports per-request contextFactory(params) to derive ExecutionContext (tenant/user/budget/etc.). Source: [packages/mcp-server/src/server.ts](../../packages/mcp-server/src/server.ts#L43).
  - MCP client callTool sends _meta.executionContext containing executionId, tenantId, userId, deadline, budget, metadata. Source: [packages/mcp-client/src/client.ts](../../packages/mcp-client/src/client.ts#L82).

- Session lifecycle
  - Client lifecycle is connect(transport) -> initialize handshake -> notifications/initialized, then list/call/read methods over the same transport with pending request correlation map. Sources: [packages/mcp-client/src/client.ts](../../packages/mcp-client/src/client.ts#L38), [packages/mcp-client/src/client.ts](../../packages/mcp-client/src/client.ts#L58), [packages/mcp-client/src/client.ts](../../packages/mcp-client/src/client.ts#L74).

- Tool arguments and validation
  - MCP tool definitions use JsonSchema inputSchema contracts; handler receives Record<string, unknown>. Validation beyond schema declaration is handler-owned. Sources: [packages/core/src/mcp.ts](../../packages/core/src/mcp.ts#L11), [packages/core/src/mcp.ts](../../packages/core/src/mcp.ts#L102), [packages/mcp-server/src/server.ts](../../packages/mcp-server/src/server.ts#L86).

- Resource access model
  - Resources are URI-addressed and read via resources/read returning MCPResourceContent (text/blob). Sources: [packages/core/src/mcp.ts](../../packages/core/src/mcp.ts#L34), [packages/core/src/mcp.ts](../../packages/core/src/mcp.ts#L42), [packages/mcp-server/src/server.ts](../../packages/mcp-server/src/server.ts#L102).

- Existing server lifecycle pattern
  - Server registers handlers via addTool/addResource/addPrompt and starts with transport.start; no package-level pooling abstraction exists here. Sources: [packages/mcp-server/src/server.ts](../../packages/mcp-server/src/server.ts#L145), [packages/mcp-server/src/server.ts](../../packages/mcp-server/src/server.ts#L157).

## 3) Conventions discovered

- Monorepo and package exports
  - Workspace is packages/* + apps/* with single-root turbo scripts; package exports are explicit dist/index maps. Sources: [package.json](../../package.json#L10), [package.json](../../package.json#L14), [packages/mcp-client/package.json](../../packages/mcp-client/package.json#L1), [packages/core/package.json](../../packages/core/package.json#L1).

- Test and examples execution
  - Examples are typechecked by test:examples in root and conventionally run with tsx; GeneWeave API and Playwright suites are script-defined in app package. Sources: [package.json](../../package.json#L18), [apps/geneweave/package.json](../../apps/geneweave/package.json#L17), [apps/geneweave/package.json](../../apps/geneweave/package.json#L18).

- Playwright setup
  - GeneWeave Playwright config launches deploy/server.ts as webServer when BASE_URL is not provided and sets PLAYWRIGHT_E2E=1 for deterministic runs. Source: [apps/geneweave/playwright.config.ts](../../apps/geneweave/playwright.config.ts#L23).

- Deployment/developer runtime
  - deploy/server.ts is production entrypoint with env-driven provider selection and startup; Azure deployment files are already present for container apps and workflow deployment. Sources: [deploy/server.ts](../../deploy/server.ts#L1), [deploy/azure-container-app.yaml](../../deploy/azure-container-app.yaml#L1), [.github/workflows/deploy-azure.yml](../../.github/workflows/deploy-azure.yml#L1).

- Instructions/docs files availability
  - Repo contains .github/copilot-instructions.md as active architecture guidance; CONTRIBUTING.md, ARCHITECTURE.md, CLAUDE.md, AGENTS.md, and .cursor/rules were not found in workspace. Source: [.github/copilot-instructions.md](../../.github/copilot-instructions.md#L1).

## 4) Application-layer persistence patterns from apps/geneweave

- Boot sequence pattern
  - createGeneWeave wires DB adapter, ChatEngine, seed routines, tool catalog sync, tool health background job, then HTTP server listener. Source: [apps/geneweave/src/index.ts](../../apps/geneweave/src/index.ts#L92).

- Server pattern
  - HTTP layer is zero-dependency node:http with custom router, auth/CSRF handling, and route-level auth/csrf options. Source: [apps/geneweave/src/server.ts](../../apps/geneweave/src/server.ts#L1), [apps/geneweave/src/server.ts](../../apps/geneweave/src/server.ts#L63), [apps/geneweave/src/server.ts](../../apps/geneweave/src/server.ts#L82).

- Chat/tool policy wiring
  - ChatEngine constructor wires DB-backed tool policy resolver, audit emitter, rate limiter, approval gate, and credential resolver. Source: [apps/geneweave/src/chat.ts](../../apps/geneweave/src/chat.ts#L236).

- Persistence boundary takeaway
  - Framework packages remain runtime libraries; app owns DB/auth/http/background jobs, matching the target split for apps/live-agents-demo. Sources: [apps/geneweave/src/index.ts](../../apps/geneweave/src/index.ts#L107), [apps/geneweave/src/server.ts](../../apps/geneweave/src/server.ts#L1), [.github/copilot-instructions.md](../../.github/copilot-instructions.md#L3).

## 5) Conflicts and ambiguities found

- Some framework packages do not currently include README or local tests, which limits package-level discoverability and forces discovery via index exports and app usage.
- tools-* package patterns are heterogeneous (some explicit MCP-heavy modules, some smaller direct tool modules), so live-agents should standardize on a strict MCP session adapter layer when implementing external actions.
- Existing identity package offers runtime identity context, while app-level vault and credential persistence patterns are currently implemented in app space; live-agents should keep credential refs only and defer secret material to app adapters.

## 6) Decisions required from human

No open decisions required from human for Phase 0 completion.

Resolved defaults for implementation planning (non-blocking, can be changed in later ADRs):
- Keep package/app split strict: no DB/migrations/server code inside packages/live-agents.
- Use MCP for external-system access from live-agents action execution.
- Keep account credential references in framework state; resolve secrets via app-provided identity/vault adapter.
- Implement in-memory-first StateStore in package; app-backed durable store in apps/live-agents-demo.

## 7) Phase 0 completion checklist

- [x] Package discovery completed for all required package groups
- [x] MCP auth/lifecycle/typing/resource patterns documented
- [x] Conventions documented (layout, exports, test style, deployment/runtime)
- [x] apps/geneweave persistence and boot patterns documented
- [x] Conflicts/ambiguities documented
- [x] Decisions required from human section is empty
