# weaveIntel — Platform Expansion Implementation Plan

## 1. Repository Review Summary

### Current State

weaveIntel is a protocol-first AI agent framework implemented as a TypeScript monorepo with **15 packages**. Core contracts are vendor-free. The architecture follows capability-driven dispatch, composable middleware, and event-driven observability.

| Package | Status | Key Capabilities |
|---|---|---|
| `@weaveintel/core` | ✅ Complete | 25 contract modules: models, agents, tools, memory, security, events, middleware, MCP, A2A, evals, connectors, retrieval, observability |
| `@weaveintel/models` | ✅ Complete | Model router, fallback chains, middleware composition, capability-based selection |
| `@weaveintel/agents` | ✅ Complete | ReAct agent loop, supervisor-worker delegation, streaming, policy hooks |
| `@weaveintel/memory` | ✅ Complete | Conversation, semantic (embedding-based), entity memory stores |
| `@weaveintel/retrieval` | ✅ Complete | 6 chunking strategies, embedding pipeline, vector retrieval + reranking |
| `@weaveintel/observability` | ⚠️ Partial | Console + in-memory tracers only; no OTLP/production sinks |
| `@weaveintel/redaction` | ✅ Complete | PII detection, reversible tokenization, policy engine |
| `@weaveintel/mcp-client` | ✅ Complete | JSON-RPC MCP client, tool bridging |
| `@weaveintel/mcp-server` | ✅ Complete | JSON-RPC MCP server, tool/resource/prompt serving |
| `@weaveintel/a2a` | ✅ Complete | HTTP + in-process agent-to-agent bus |
| `@weaveintel/evals` | ⚠️ Partial | 8 assertion types; `model_graded`, `pairwise`, `factuality` stubbed |
| `@weaveintel/testing` | ✅ Complete | Fake model, embedding, vector store, transport |
| `@weaveintel/provider-openai` | ⚠️ Partial | Chat + embeddings; audio, files, moderation, fine-tuning, batch stubbed |
| `@weaveintel/provider-anthropic` | ✅ Complete | Chat, tool use, vision, PDF, thinking, citations, caching |
| `@weaveintel/geneweave` | ⚠️ WIP | Reference chat app with auth, streaming, dashboard |

### Dependency Graph (current)

```
@weaveintel/core  (zero dependencies)
  ├── @weaveintel/models
  ├── @weaveintel/agents  → core, models
  ├── @weaveintel/memory  → core
  ├── @weaveintel/retrieval → core
  ├── @weaveintel/observability → core
  ├── @weaveintel/redaction → core
  ├── @weaveintel/mcp-client → core
  ├── @weaveintel/mcp-server → core
  ├── @weaveintel/a2a → core
  ├── @weaveintel/evals → core
  ├── @weaveintel/testing → core
  ├── @weaveintel/provider-openai → core, models
  ├── @weaveintel/provider-anthropic → core, models
  └── @weaveintel/geneweave → core, agents, observability, redaction, evals
```

---

## 2. Gap Analysis

### What exists vs. what is needed

| Capability Area | Exists Today | Gap |
|---|---|---|
| **Workflow orchestration** | Agent loop + supervisor delegation | No workflow runtime, no steps, no branching, no checkpoints, no wait/resume, no durable state |
| **Guardrails & governance** | Basic policy engine in redaction | No input/output guardrails, no tool invocation guards, no risk scoring, no confidence gating, no composable guardrail pipeline |
| **Human-in-the-loop** | None | No approval tasks, no review queues, no escalation, no pause/resume at human checkpoints |
| **Completion contracts** | None | No task schemas, no acceptance criteria, no validation hooks, no structured completion reports |
| **Prompt management** | Plain strings in config | No versioning, no templates, no variables, no A/B testing, no prompt registry |
| **Model routing** | Basic fallback chains in models | No routing by cost/latency/eval/capability/health, no speculative routing, no explainable decisions |
| **Advanced retrieval** | Chunking + vector search + reranking | No hybrid retrieval, no ACL-aware filters, no query rewriting, no multi-hop, no citation stitching, no freshness/trust scoring |
| **Caching** | None | No semantic cache, no request cache, no tool result cache, no TTL, no invalidation |
| **Memory governance** | Basic memory with TTL | No confidence scores, no provenance, no dedup, no conflict resolution, no write policies, no forgetting flows |
| **Identity & auth** | JWT auth in geneweave only | No runtime identity, no delegated access, no scoped credentials, no agent identity, no per-tenant auth |
| **Tool lifecycle** | Tool registry + approval policy | No versioning, no risk classification, no side-effect classification, no dry-run, no health telemetry |
| **Eval & replay** | Eval runner with assertions | No replay engine, no scenario packs, no golden datasets, no regression detection, no model comparison |
| **Advanced observability** | Console + in-memory tracers | No OTLP, no delegation traces, no plan revision events, no budget tracking, no cost summaries |
| **Event-driven execution** | Event bus (in-memory) | No webhook triggers, no cron, no queue triggers, no file/change triggers |
| **Multi-tenancy** | `tenantId` in ExecutionContext | No config inheritance, no tenant policies, no entitlements, no per-tenant budgets |
| **Sandbox** | None | No isolated execution, no resource limits, no network restrictions |
| **Document extraction** | Chunking strategies | No OCR hooks, no table extraction, no entity extraction, no timeline extraction |
| **Collaboration** | None | No shared sessions, no live subscriptions, no presence, no handoff |
| **Plugin system** | Plugin registry in core (basic) | No manifest, no lifecycle hooks, no compatibility checks, no trust levels |
| **Developer experience** | Examples | No CLI, no scaffolding, no config validation, no dev inspector |
| **UI primitives** | SSE streaming in geneweave | No structured UI events, no approval payloads, no citation model, no artifact payloads |
| **Artifacts** | None | No artifact store, no versioning, no typed outputs (CSV, diagrams, reports) |
| **Reliability** | Retry middleware in core | No idempotency, no dead-letter handling, no backpressure, no distributed locking |
| **Compliance** | None | No retention policies, no right-to-delete, no legal hold, no data residency |
| **Knowledge graph** | None | No entity nodes, no relationships, no graph memory, no graph-assisted retrieval |

---

## 3. Target Architecture

### Design Principles

1. **Protocol-first** — All capabilities defined as interfaces in `core`. Implementations live in dedicated packages.
2. **Composable, not monolithic** — Each subsystem is independently usable. No god-class runtime.
3. **Vendor-neutral** — Core remains free of vendor dependencies. Providers are thin adapters.
4. **Observable by default** — Every subsystem emits events to the event bus. Tracing is built-in, not bolted-on.
5. **Policy-driven** — Guardrails, routing, tool approval, memory governance — all configurable and replaceable.
6. **Incrementally adoptable** — A user can use just agents + tools, or the full workflow engine. No forced bundling.
7. **Three-layer API** — Low-level primitives → builder APIs → batteries-included recipes.

### System Interaction Map

```
┌─────────────────────────────────────────────────────────────┐
│                    Layer 3: Recipes                          │
│  createWorkflowAgent · createGovernedAssistant              │
│  createApprovalDrivenAgent · createEvalRoutedAssistant      │
├─────────────────────────────────────────────────────────────┤
│                    Layer 2: Builders                         │
│  Workflow Definitions · Guardrail Pipelines                 │
│  Prompt Resolvers · Routing Policies · Cache Policies       │
├─────────────────────────────────────────────────────────────┤
│                    Layer 1: Primitives                       │
│                                                              │
│  ┌──────────┐ ┌───────────┐ ┌────────────┐ ┌────────────┐  │
│  │Workflows │ │ Guardrails│ │Human Tasks │ │ Contracts  │  │
│  └────┬─────┘ └─────┬─────┘ └─────┬──────┘ └─────┬──────┘  │
│       │             │             │               │          │
│  ┌────┴─────────────┴─────────────┴───────────────┴──────┐  │
│  │                    @weaveintel/core                     │  │
│  │  Models · Agents · Tools · Memory · Events · Policies  │  │
│  │  MCP · A2A · Evals · Connectors · Middleware           │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────┐ ┌───────┐ ┌────────┐ ┌────────┐ ┌─────────┐  │
│  │ Prompts  │ │ Cache │ │Identity│ │ Graph  │ │Artifacts│  │
│  └──────────┘ └───────┘ └────────┘ └────────┘ └─────────┘  │
│                                                              │
│  ┌──────────┐ ┌────────┐ ┌──────────┐ ┌─────────┐          │
│  │ Routing  │ │Sandbox │ │Compliance│ │ Plugins │          │
│  └──────────┘ └────────┘ └──────────┘ └─────────┘          │
│                                                              │
│  ┌──────────────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │  Observability   │ │  Replay  │ │ Event Triggers    │   │
│  └──────────────────┘ └──────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Package Tree (Target)

### New packages to create

```
packages/
  ├── core/                      # ← EXTEND (add new interfaces)
  ├── workflows/                 # NEW — Workflow runtime
  ├── guardrails/                # NEW — Guardrail pipeline & governance
  ├── human-tasks/               # NEW — Human-in-the-loop orchestration
  ├── contracts/                 # NEW — Completion contracts & validation
  ├── prompts/                   # NEW — Prompt registry & management
  ├── routing/                   # NEW — Model routing engine
  ├── cache/                     # NEW — Semantic & operational caching
  ├── identity/                  # NEW — Identity, auth, delegated access
  ├── tools/                     # NEW — Extended tool registry & lifecycle
  ├── replay/                    # NEW — Evaluation replay & regression
  ├── triggers/                  # NEW — Event-driven execution
  ├── tenancy/                   # NEW — Multi-tenancy & config inheritance
  ├── sandbox/                   # NEW — Safe execution environment
  ├── extraction/                # NEW — Document transformation pipelines
  ├── collaboration/             # NEW — Real-time collaboration primitives
  ├── plugins/                   # NEW — Plugin packaging & marketplace
  ├── artifacts/                 # NEW — Artifact generation & storage
  ├── reliability/               # NEW — Reliability engineering
  ├── compliance/                # NEW — Enterprise compliance hooks
  ├── graph/                     # NEW — Knowledge graph & entity graph
  ├── ui-primitives/             # NEW — Structured UI event payloads
  ├── devtools/                  # NEW — Developer experience utilities
  ├── recipes/                   # NEW — Batteries-included compositions
  │
  ├── models/                    # ← EXTEND
  ├── agents/                    # ← EXTEND
  ├── memory/                    # ← EXTEND (governance)
  ├── retrieval/                 # ← EXTEND (hybrid, ACL, multi-hop)
  ├── observability/             # ← EXTEND (OTLP, budget tracking)
  ├── evals/                     # ← EXTEND (golden datasets, regression)
  ├── testing/                   # ← EXTEND (more fakes)
  ├── redaction/                 # Stable
  ├── mcp-client/                # Stable
  ├── mcp-server/                # Stable
  ├── a2a/                       # Stable
  ├── provider-openai/           # ← EXTEND (stubbed APIs)
  ├── provider-anthropic/        # Stable
  └── geneweave/                 # ← EXTEND (integrate new features)
```

### Target Dependency Graph (new packages)

```
@weaveintel/core  (zero dependencies — all new interfaces added here first)
  │
  ├── @weaveintel/workflows → core
  ├── @weaveintel/guardrails → core
  ├── @weaveintel/human-tasks → core
  ├── @weaveintel/contracts → core
  ├── @weaveintel/prompts → core
  ├── @weaveintel/routing → core, models
  ├── @weaveintel/cache → core
  ├── @weaveintel/identity → core
  ├── @weaveintel/tools → core
  ├── @weaveintel/replay → core, evals
  ├── @weaveintel/triggers → core
  ├── @weaveintel/tenancy → core
  ├── @weaveintel/sandbox → core
  ├── @weaveintel/extraction → core, retrieval
  ├── @weaveintel/collaboration → core
  ├── @weaveintel/plugins → core
  ├── @weaveintel/artifacts → core
  ├── @weaveintel/reliability → core
  ├── @weaveintel/compliance → core
  ├── @weaveintel/graph → core, memory
  ├── @weaveintel/ui-primitives → core
  ├── @weaveintel/devtools → core
  └── @weaveintel/recipes → core, agents, workflows, guardrails, routing, prompts
```

**Rule:** No circular dependencies. Every new package depends on core. Cross-package dependencies only where justified.

---

## 5. Phased Implementation Plan

### Phase 0 — Foundation (Core Interface Expansion)
**Duration estimate: Foundation for all other phases**

Extend `@weaveintel/core` with interface definitions for every new subsystem. No implementations — just contracts. This is the prerequisite for all phases.

**New files in `packages/core/src/`:**

| File | Interfaces |
|---|---|
| `workflows.ts` | `Workflow`, `WorkflowDefinition`, `WorkflowRun`, `WorkflowStep`, `WorkflowState`, `WorkflowCheckpoint`, `WorkflowTrigger`, `WorkflowScheduler`, `WorkflowEngine`, `WorkflowPolicy`, `WorkflowCompensation`, `WorkflowEvent`, `WorkflowApprovalTask` |
| `guardrails.ts` | `Guardrail`, `GuardrailResult`, `GuardrailPipeline`, `PolicyDecision`, `RuntimePolicy`, `RiskClassifier`, `ConfidenceGate`, `ActionGate`, `GovernanceRule`, `GovernanceContext` |
| `human-tasks.ts` | `HumanTask`, `ApprovalTask`, `ReviewTask`, `EscalationTask`, `HumanDecision`, `HumanTaskQueue`, `HumanTaskPolicy` |
| `contracts.ts` | `TaskContract`, `CompletionContract`, `AcceptanceCriteria`, `CompletionReport`, `ValidationResult`, `EvidenceBundle`, `TaskOutcome`, `FailureReason`, `CompletionValidator` |
| `prompts.ts` | `PromptDefinition`, `PromptTemplate`, `PromptVersion`, `PromptRegistry`, `InstructionBundle`, `PromptVariant`, `PromptExperiment`, `PromptResolver` |
| `routing.ts` | `ModelRouter`, `RoutingPolicy`, `RoutingDecision`, `ModelHealth`, `ModelScore`, `FallbackPlan`, `RoutingContext` |
| `cache.ts` | `CacheStore`, `SemanticCache`, `CachePolicy`, `CacheKeyBuilder`, `CacheInvalidationRule`, `CacheScope` |
| `identity.ts` | `RuntimeIdentity`, `IdentityContext`, `DelegationContext`, `AccessTokenResolver`, `SecretScope`, `PermissionDescriptor`, `AccessDecision` |
| `tool-lifecycle.ts` | `ToolDescriptor`, `ToolVersion`, `ToolRiskLevel`, `ToolLifecyclePolicy`, `ToolTestHarness`, `ToolHealth`, `ToolExecutionPolicy` |
| `replay.ts` | `ReplayEngine`, `ReplayScenario`, `BenchmarkSuite`, `EvalScenario`, `EvalRegression`, `ComparisonRun`, `GoldenCase`, `RunArtifact` |
| `triggers.ts` | `EventTrigger`, `TriggerDefinition`, `TriggerSubscription`, `EventEnvelope`, `TriggerHandler`, `EventDrivenWorkflowBinding` |
| `tenancy.ts` | `ConfigScope`, `EffectiveConfig`, `ConfigResolver`, `EntitlementPolicy`, `TenantPolicy`, `TenantCapabilityMap`, `OverrideLayer` |
| `sandbox.ts` | `Sandbox`, `SandboxPolicy`, `ExecutionLimits`, `ExecutionArtifact`, `SandboxResult`, `RestrictedEnvironment` |
| `extraction.ts` | `DocumentTransformPipeline`, `ExtractionStage`, `ExtractedEntity`, `ExtractedTask`, `ExtractedTimeline`, `ExtractionResult`, `TransformationArtifact` |
| `collaboration.ts` | `SharedSession`, `SessionParticipant`, `CollaborationEvent`, `SharedContext`, `RunSubscription`, `PresenceState` |
| `plugins.ts` | `PluginManifest`, `PluginCapability`, `PluginCompatibilityResult`, `PluginTrustLevel`, `PluginInstaller`, `PluginLifecycle` |
| `artifacts.ts` | `Artifact`, `ArtifactType`, `ArtifactStore`, `ArtifactVersion`, `ArtifactReference`, `ArtifactPolicy` |
| `reliability.ts` | `IdempotencyPolicy`, `RetryBudget`, `DeadLetterRecord`, `ConcurrencyPolicy`, `BackpressureSignal`, `HealthStatus`, `FailureEnvelope` |
| `compliance.ts` | `CompliancePolicy`, `RetentionRule`, `DeletionRequest`, `LegalHold`, `ResidencyConstraint`, `AuditExport`, `ConsentFlag` |
| `graph.ts` | `EntityNode`, `RelationshipEdge`, `GraphMemoryStore`, `EntityLinker`, `TimelineGraph`, `GraphRetriever` |
| `ui-events.ts` | `UiEvent`, `StreamEnvelope`, `ProgressUpdate`, `ApprovalUiPayload`, `CitationPayload`, `ArtifactPayload`, `WidgetPayload` |

**Why first:** Every implementation package depends on core interfaces. Defining contracts first ensures consistency and prevents circular dependencies.

---

### Phase 1 — Workflow Runtime & Guardrails
**Priority: CRITICAL — foundational for phases 2–6**

These are the two most essential new subsystems. Workflows underpin orchestration. Guardrails underpin trust.

#### 1A. `@weaveintel/workflows`
**Why:** The platform has agents but no durable workflow orchestration. Real production systems need deterministic steps, branching, checkpoints, and resumability.

**What it solves:**
- Long-running processes that survive restarts
- Mixed deterministic + agentic execution
- Pause/resume at human approval points
- Compensation/rollback for failures

**Package structure:**
```
packages/workflows/src/
  ├── index.ts              # Public API
  ├── engine.ts             # WorkflowEngine — runs workflow definitions
  ├── definition.ts         # WorkflowDefinition builder API
  ├── state.ts              # WorkflowState management, checkpointing
  ├── steps.ts              # Step types: deterministic, agentic, branch, loop, condition, wait
  ├── scheduler.ts          # Cron and delayed execution
  ├── compensation.ts       # Rollback and compensation handlers
  └── checkpoint-store.ts   # Durable state persistence (in-memory default)
```

**Key design decisions:**
- Workflow definitions are serializable (JSON-friendly)
- Steps can be deterministic functions or agentic (model calls)
- Engine emits events on every state transition
- Checkpoint store is pluggable (in-memory for dev, DB for prod)
- Budget and deadline enforcement from ExecutionContext
- Subworkflow support via composition

**First test:** A 3-step workflow: (1) classify input, (2) branch to agent or deterministic handler, (3) collect result with checkpoint.

#### 1B. `@weaveintel/guardrails`
**Why:** Agents calling tools and producing output without governance is unsafe for production.

**What it solves:**
- Input validation before model calls
- Output validation after model responses
- Tool invocation gating by risk level
- Cost/token ceiling enforcement
- Prompt injection detection hooks

**Package structure:**
```
packages/guardrails/src/
  ├── index.ts              # Public API
  ├── pipeline.ts           # GuardrailPipeline — ordered evaluation chain
  ├── guardrail.ts          # Built-in guardrails: regex, blocklist, length, schema
  ├── risk-classifier.ts    # Action risk scoring
  ├── confidence-gate.ts    # Confidence-based action gating
  ├── governance.ts         # GovernanceContext — runtime policy resolution
  └── cost-guard.ts         # Token and cost ceiling enforcement
```

**Key design decisions:**
- Guardrails are composable: `pre-execution → mid-execution → post-execution`
- Each guardrail returns `GuardrailResult` with `allow | deny | warn` and explanation
- Pipeline short-circuits on first `deny` (configurable)
- Policy logic is never hardcoded — all rules are config objects
- Integrates with event bus for observability

**First test:** An agent with input guardrail (no PII), tool guardrail (no destructive tools), and output guardrail (no harmful content).

---

### Phase 2 — Human Tasks & Completion Contracts
**Priority: HIGH — required for production approval workflows**

#### 2A. `@weaveintel/human-tasks`
**Why:** Production AI systems need human oversight at decision points.

**What it solves:**
- Pausing execution for human review
- Approval/rejection workflows
- Escalation when confidence is low
- SLA enforcement for review deadlines
- Audit trail of human decisions

**Package structure:**
```
packages/human-tasks/src/
  ├── index.ts              # Public API
  ├── task.ts               # HumanTask, ApprovalTask, ReviewTask, EscalationTask
  ├── queue.ts              # HumanTaskQueue with priority and SLA
  ├── decision.ts           # HumanDecision recording with audit
  └── policy.ts             # HumanTaskPolicy — when to require approval
```

**Workflow integration:** Workflows pause at `waitForApproval` steps. Human tasks are created in a queue. External systems (UI, API) submit decisions. Workflow resumes.

#### 2B. `@weaveintel/contracts`
**Why:** Agents and workflows need structured agreements about what "done" means.

**What it solves:**
- Explicit task schemas for agent outputs
- Acceptance criteria validation
- Evidence requirements
- Structured failure reporting
- Supervisor validation of worker results

**Package structure:**
```
packages/contracts/src/
  ├── index.ts              # Public API
  ├── contract.ts           # TaskContract, CompletionContract definitions
  ├── validator.ts          # CompletionValidator — checks criteria
  ├── report.ts             # CompletionReport, EvidenceBundle
  └── outcome.ts            # TaskOutcome, FailureReason taxonomy
```

**First test:** A supervisor assigns a task with a contract to a worker. Worker returns a completion report. Supervisor validates against criteria.

---

### Phase 3 — Prompt Management & Model Routing
**Priority: HIGH — essential for production model operations**

#### 3A. `@weaveintel/prompts`
**Why:** Prompts as plain strings don't support versioning, A/B testing, rollback, or tenant overrides.

**What it solves:**
- Versioned prompt templates with variables
- System, task, and formatting instructions composed into bundles
- Tenant and environment overrides
- Prompt experiments and A/B testing
- Prompt-to-eval linkage for quality tracking

**Package structure:**
```
packages/prompts/src/
  ├── index.ts              # Public API
  ├── registry.ts           # PromptRegistry — versioned storage
  ├── template.ts           # PromptTemplate with variable substitution
  ├── resolver.ts           # PromptResolver — resolves effective prompt from scopes
  ├── experiment.ts         # PromptExperiment, PromptVariant, A/B selection
  └── instructions.ts       # InstructionBundle — composable instruction layers
```

#### 3B. `@weaveintel/routing`
**Why:** The current model router has fallback chains but no intelligent routing by cost, latency, eval scores, or provider health.

**What it solves:**
- Routing by capability, cost, latency, eval scores
- Provider health monitoring
- Speculative/canary routing
- Explainable routing decisions (logged and inspectable)
- Tenant-specific routing preferences

**Package structure:**
```
packages/routing/src/
  ├── index.ts              # Public API
  ├── router.ts             # ModelRouter — evaluates routing policies
  ├── policy.ts             # RoutingPolicy definitions (cost, latency, capability, etc.)
  ├── health.ts             # ModelHealth tracking (latency, error rate, availability)
  ├── scorer.ts             # ModelScore computation from multiple signals
  └── decision.ts           # RoutingDecision — explainable, logged
```

**First test:** Route a request with a cost budget. Router picks cheapest capable model. Decision is logged with explanation.

---

### Phase 4 — Caching, Memory Governance & Identity
**Priority: HIGH — production readiness**

#### 4A. `@weaveintel/cache`
**Why:** Repeated identical (or semantically similar) requests waste tokens and money.

**What it solves:**
- Exact request caching
- Semantic similarity caching (embedding-based)
- Tool result caching
- Per-tenant cache isolation
- TTL and invalidation on source changes

**Package structure:**
```
packages/cache/src/
  ├── index.ts              # Public API
  ├── store.ts              # CacheStore — pluggable backends (in-memory default)
  ├── semantic.ts           # SemanticCache — embedding-based similarity matching
  ├── policy.ts             # CachePolicy, TTL, bypass rules
  ├── key-builder.ts        # CacheKeyBuilder — deterministic key generation
  └── invalidation.ts       # CacheInvalidationRule — source-change triggers
```

#### 4B. Memory governance (extend `@weaveintel/memory`)
**Why:** Memory without governance leads to stale, conflicting, or sensitive data persisting unchecked.

**New files in `packages/memory/src/`:**
```
  ├── governance.ts         # MemoryGovernancePolicy, write policies
  ├── provenance.ts         # MemoryProvenance — tracks origin and confidence
  ├── dedup.ts              # MemoryDeduplication and conflict resolution
  ├── correction.ts         # MemoryCorrection workflows
  └── expiry.ts             # Memory expiry and forgetting flows
```

#### 4C. `@weaveintel/identity`
**Why:** Multi-tenant production systems need runtime identity, delegated access, and scoped credentials.

**Package structure:**
```
packages/identity/src/
  ├── index.ts              # Public API
  ├── context.ts            # IdentityContext, RuntimeIdentity
  ├── delegation.ts         # DelegationContext — on-behalf-of access
  ├── access.ts             # AccessDecision, PermissionDescriptor
  ├── secrets.ts            # SecretScope, AccessTokenResolver
  └── evaluator.ts          # Access evaluation for tools and connectors
```

---

### Phase 5 — MCP Tool Ecosystem, Advanced Retrieval & Observability
**All tools are exposed and invoked via MCP** — every capability registers as an MCP tool, discoverable by any MCP-compatible agent or client.
**Priority: MEDIUM-HIGH — operational maturity**

#### 5A. `@weaveintel/tools` (extended tool registry + MCP bridge)
**Why:** Tools need risk classification, versioning, health tracking, test harnesses, and automatic MCP exposure for production safety and interoperability.

**Package structure:**
```
packages/tools/src/
  ├── index.ts              # Public API
  ├── registry.ts           # Extended ToolRegistry with versioning, discovery, and MCP auto-registration
  ├── descriptor.ts         # ToolDescriptor — rich metadata, risk level, side effects, rate limits
  ├── lifecycle.ts          # ToolLifecyclePolicy — approval workflows, deprecation, sunset schedules
  ├── health.ts             # ToolHealth telemetry — uptime, latency, error rates, circuit breaker
  ├── harness.ts            # ToolTestHarness — test tools in isolation with mock contexts
  └── mcp-bridge.ts         # MCPToolBridge — auto-exposes all registered tools as MCP tools, routes MCP calls to implementations
```

**Tool risk categories:**
- `read-only` — safe, no side effects
- `write` — modifies data
- `destructive` — irreversible operations
- `privileged` — elevated permissions required
- `financial` — monetary impact
- `external-side-effect` — calls external services

**MCP integration:**
- Every tool registered via `ToolRegistry` is automatically available as an MCP tool
- MCP tool calls route through the same lifecycle (risk check → approval → execute → audit)
- Remote MCP servers can be mounted as tool namespaces (e.g., `search.*`, `social.*`)

#### 5B. `@weaveintel/tools-search` (web search via MCP)
**Why:** Agents need web search to answer real-time questions, research topics, and verify facts. Each provider is an MCP tool, allowing agents to pick the best source for a query.

**Package structure:**
```
packages/tools-search/src/
  ├── index.ts              # Public API — re-exports all search tools
  ├── base.ts               # BaseSearchTool — shared interface, result normalisation, rate limiting
  ├── types.ts              # SearchResult, SearchOptions, SearchProvider config types
  ├── providers/
  │   ├── searxng.ts        # SearXNG — self-hosted meta-search (configurable instance URL)
  │   ├── google-pse.ts     # Google Programmable Search Engine (API key + CX ID)
  │   ├── brave.ts          # Brave Search API
  │   ├── kagi.ts           # Kagi Search API
  │   ├── mojeek.ts         # Mojeek Search API
  │   ├── tavily.ts         # Tavily AI-optimised search
  │   ├── perplexity.ts     # Perplexity Sonar search API
  │   ├── serpstack.ts      # serpstack SERP API
  │   ├── serper.ts         # Serper.dev Google SERP API
  │   ├── serply.ts         # Serply search API
  │   ├── duckduckgo.ts     # DuckDuckGo Instant Answer API
  │   ├── searchapi.ts      # SearchApi.io multi-engine
  │   ├── serpapi.ts         # SerpApi multi-engine
  │   ├── bing.ts           # Bing Web Search API (Azure Cognitive Services key)
  │   ├── jina.ts           # Jina AI reader / search API
  │   ├── exa.ts            # Exa neural search API
  │   ├── sogou.ts          # Sogou Search API (Chinese web)
  │   └── azure-ai-search.ts # Azure AI Search (index-based, vector + keyword hybrid)
  ├── router.ts             # SearchRouter — pick best provider by query type, region, cost, availability
  └── mcp.ts                # MCP registration — exposes each provider as `search.<provider>` MCP tool and a unified `search.query` meta-tool
```

**Normalised result shape** (all providers map to this):
```ts
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;          // provider name
  publishedAt?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}
```

**MCP tools exposed:**
| MCP Tool Name | Description |
|---|---|
| `search.query` | Unified meta-search — picks best provider(s) via `SearchRouter`, deduplicates and ranks results |
| `search.searxng` | Query a SearXNG instance |
| `search.google` | Google Programmable Search Engine |
| `search.brave` | Brave Search |
| `search.kagi` | Kagi Search |
| `search.mojeek` | Mojeek Search |
| `search.tavily` | Tavily AI search |
| `search.perplexity` | Perplexity Sonar |
| `search.serpstack` | serpstack SERP |
| `search.serper` | Serper.dev |
| `search.serply` | Serply |
| `search.duckduckgo` | DuckDuckGo Instant Answer |
| `search.searchapi` | SearchApi.io |
| `search.serpapi` | SerpApi |
| `search.bing` | Bing Web Search |
| `search.jina` | Jina reader/search |
| `search.exa` | Exa neural search |
| `search.sogou` | Sogou Search |
| `search.azure_ai_search` | Azure AI Search (hybrid vector + keyword) |

#### 5C. `@weaveintel/tools-http` (REST API calling via MCP)
**Why:** Agents need to call arbitrary REST APIs — internal microservices, third-party SaaS, webhooks. This provides a secure, auditable HTTP tool with schema validation, auth injection, and retry.

**Package structure:**
```
packages/tools-http/src/
  ├── index.ts              # Public API
  ├── types.ts              # HTTPToolConfig, RequestTemplate, AuthConfig types
  ├── client.ts             # HTTPTool — make GET/POST/PUT/PATCH/DELETE requests with configurable auth, headers, body templates
  ├── auth.ts               # Auth strategies: API key, Bearer token, OAuth2 client-credentials, Basic, custom header
  ├── schema.ts             # Request/response JSON Schema validation
  ├── retry.ts              # Retry policy with exponential backoff, circuit breaker
  ├── transform.ts          # Response transformers — extract JSON path, XML→JSON, HTML→text
  └── mcp.ts                # MCP registration — exposes `http.request`, `http.get`, `http.post` as MCP tools
```

**MCP tools exposed:**
| MCP Tool Name | Description |
|---|---|
| `http.request` | Generic HTTP request (method, url, headers, body, auth config) |
| `http.get` | Convenience GET with query params |
| `http.post` | Convenience POST with JSON/form body |
| `http.graphql` | GraphQL query/mutation executor |

#### 5D. `@weaveintel/tools-browser` (web extraction via MCP)
**Why:** Agents need to read web pages, extract structured data, take screenshots, and interact with dynamic content for research, monitoring, and data gathering.

**Package structure:**
```
packages/tools-browser/src/
  ├── index.ts              # Public API
  ├── types.ts              # BrowserConfig, ExtractionResult, ScreenshotOptions types
  ├── fetcher.ts            # SimpleFetcher — lightweight HTTP fetch + Readability extraction (no browser needed)
  ├── scraper.ts            # BrowserScraper — Playwright-based full browser: render, extract, screenshot
  ├── extractor.ts          # ContentExtractor — HTML→markdown, HTML→structured JSON, CSS/XPath selectors
  ├── readability.ts        # ReadabilityExtractor — article text, title, author, date via Readability algorithm
  ├── screenshot.ts         # ScreenshotTool — full-page or element screenshot, PDF export
  ├── sitemap.ts            # SitemapCrawler — discover pages from sitemap.xml
  └── mcp.ts                # MCP registration — exposes browser tools as MCP tools
```

**MCP tools exposed:**
| MCP Tool Name | Description |
|---|---|
| `browser.fetch` | Lightweight HTTP fetch + Readability text extraction (no JS rendering) |
| `browser.scrape` | Full Playwright-based page render, wait for selectors, extract content |
| `browser.screenshot` | Capture screenshot of a URL or element (PNG/JPEG) |
| `browser.extract` | Extract structured data from HTML using CSS/XPath selectors |
| `browser.pdf` | Render a URL to PDF |
| `browser.sitemap` | Crawl sitemap.xml and return page list |

#### 5E. `@weaveintel/tools-social` (social media platform APIs via MCP)
**Why:** Agents need to read, post, and manage content across social platforms. Each platform adapter wraps its REST/Graph API and exposes actions as MCP tools with proper OAuth and rate-limit handling.

**Package structure:**
```
packages/tools-social/src/
  ├── index.ts              # Public API
  ├── types.ts              # SocialPost, SocialProfile, SocialComment, MediaAttachment, PaginatedResult types
  ├── base.ts               # BaseSocialAdapter — shared auth, rate limiting, pagination, error handling
  ├── platforms/
  │   ├── instagram.ts      # Instagram Graph API — read profile, feed, stories, comments; post media; reply to comments
  │   ├── facebook.ts       # Facebook Graph API — read pages/groups, posts, comments; create posts; manage page messages
  │   ├── tiktok.ts         # TikTok API — read user info, videos, comments; post videos; analytics
  │   ├── twitter.ts        # X/Twitter API v2 — read tweets, timelines, mentions; post tweets; search
  │   ├── linkedin.ts       # LinkedIn API — read profile, posts, company pages; create shares/posts
  │   └── youtube.ts        # YouTube Data API — search videos, read comments, channel info; post comments
  ├── auth/
  │   ├── oauth2.ts         # OAuth2 authorization code + refresh token flow (Instagram, Facebook, TikTok, LinkedIn)
  │   └── token-store.ts    # Encrypted token storage and refresh scheduler
  └── mcp.ts                # MCP registration — exposes each platform as `social.<platform>.<action>` MCP tools
```

**MCP tools exposed (per platform — Instagram shown as example, same pattern for all):**
| MCP Tool Name | Description |
|---|---|
| `social.instagram.profile` | Get user profile info |
| `social.instagram.feed` | Read user's media feed (paginated) |
| `social.instagram.post` | Publish a photo/video/carousel |
| `social.instagram.comments` | Read comments on a post |
| `social.instagram.reply` | Reply to a comment |
| `social.instagram.stories` | Read user's stories |
| `social.instagram.insights` | Get post/account insights (business accounts) |
| `social.facebook.*` | Same pattern — pages, groups, posts, comments, messenger |
| `social.tiktok.*` | Same pattern — user, videos, comments, analytics |
| `social.twitter.*` | Same pattern — tweets, timelines, search, post |
| `social.linkedin.*` | Same pattern — profile, posts, shares, company pages |
| `social.youtube.*` | Same pattern — search, videos, comments, channels |

#### 5F. `@weaveintel/tools-enterprise` (enterprise connectors via MCP)
**Why:** Agents need access to enterprise knowledge bases, documents, and communication — SharePoint, Confluence, email (Gmail, Microsoft 365). Each connector provides read/write MCP tools with proper auth (OAuth2, service account, API tokens).

**Package structure:**
```
packages/tools-enterprise/src/
  ├── index.ts              # Public API
  ├── types.ts              # Document, Page, Email, Attachment, DriveItem, CalendarEvent types
  ├── base.ts               # BaseEnterpriseAdapter — shared auth, pagination, error mapping
  ├── connectors/
  │   ├── sharepoint.ts     # SharePoint Online REST API — sites, lists, document libraries, pages, search
  │   ├── confluence.ts     # Confluence REST API v2 — spaces, pages, blog posts, comments, search, attachments
  │   ├── gmail.ts          # Gmail API — list/read/send/draft/reply emails, labels, attachments, search
  │   ├── microsoft-mail.ts # Microsoft Graph Mail API — list/read/send/draft/reply emails, folders, attachments, search
  │   ├── microsoft-drive.ts # Microsoft Graph OneDrive/SharePoint Files — list/read/upload/download files
  │   ├── microsoft-calendar.ts # Microsoft Graph Calendar — list/create/update events, availability
  │   ├── google-drive.ts   # Google Drive API — list/read/upload/download files, permissions
  │   ├── google-calendar.ts # Google Calendar API — list/create/update events
  │   ├── notion.ts         # Notion API — databases, pages, blocks, search
  │   ├── slack.ts          # Slack Web API — channels, messages, threads, files, search
  │   └── teams.ts          # Microsoft Teams API — teams, channels, messages, files
  ├── auth/
  │   ├── oauth2-enterprise.ts # OAuth2 flows: authorization code, client credentials, on-behalf-of
  │   ├── service-account.ts   # Service account / app-only auth (Google, Microsoft)
  │   └── token-store.ts       # Encrypted token persistence and auto-refresh
  └── mcp.ts                # MCP registration — exposes each connector as `enterprise.<platform>.<action>` MCP tools
```

**MCP tools exposed:**
| MCP Tool Name | Description |
|---|---|
| **SharePoint** | |
| `enterprise.sharepoint.search` | Search across SharePoint sites |
| `enterprise.sharepoint.list_sites` | List available sites |
| `enterprise.sharepoint.get_page` | Read a SharePoint page |
| `enterprise.sharepoint.list_documents` | List documents in a library |
| `enterprise.sharepoint.read_document` | Read/download a document |
| `enterprise.sharepoint.upload_document` | Upload a document to a library |
| **Confluence** | |
| `enterprise.confluence.search` | Search Confluence content (CQL) |
| `enterprise.confluence.get_page` | Read a Confluence page (body, metadata) |
| `enterprise.confluence.create_page` | Create a new page |
| `enterprise.confluence.update_page` | Update an existing page |
| `enterprise.confluence.get_comments` | Read page comments |
| `enterprise.confluence.add_comment` | Add a comment to a page |
| **Gmail** | |
| `enterprise.gmail.search` | Search emails (Gmail query syntax) |
| `enterprise.gmail.read` | Read an email (headers, body, attachments) |
| `enterprise.gmail.send` | Send an email |
| `enterprise.gmail.draft` | Create a draft |
| `enterprise.gmail.reply` | Reply to a thread |
| `enterprise.gmail.labels` | List/manage labels |
| **Microsoft Mail** | |
| `enterprise.microsoft_mail.search` | Search emails (Microsoft Graph) |
| `enterprise.microsoft_mail.read` | Read an email |
| `enterprise.microsoft_mail.send` | Send an email |
| `enterprise.microsoft_mail.draft` | Create a draft |
| `enterprise.microsoft_mail.reply` | Reply to a message |
| **Microsoft Drive / Google Drive** | |
| `enterprise.onedrive.*` | List, read, upload, download, search files |
| `enterprise.google_drive.*` | Same pattern |
| **Calendar** | |
| `enterprise.google_calendar.*` | List, create, update events; check availability |
| `enterprise.microsoft_calendar.*` | Same pattern |
| **Collaboration** | |
| `enterprise.notion.*` | Databases, pages, blocks, search |
| `enterprise.slack.*` | Channels, messages, threads, files, search |
| `enterprise.teams.*` | Teams, channels, messages, chat |

#### 5G. Advanced retrieval (extend `@weaveintel/retrieval`)
**New files in `packages/retrieval/src/`:**
```
  ├── hybrid.ts             # HybridRetrieverPlan — semantic + keyword fusion
  ├── acl.ts                # AccessFilter — ACL-aware retrieval
  ├── query-rewriter.ts     # QueryRewriter — LLM-based query expansion
  ├── multi-hop.ts          # Multi-hop retrieval chains
  ├── parent-child.ts       # ParentChildRetriever — hierarchical chunks
  ├── scoring.ts            # FreshnessScore, TrustScore
  ├── citations.ts          # Citation stitching and source attribution
  └── diagnostics.ts        # RetrievalDiagnostic — explain retrieval decisions
```

#### 5H. Enhanced observability (extend `@weaveintel/observability`)
**New files in `packages/observability/src/`:**
```
  ├── otlp.ts               # OpenTelemetry sink
  ├── budget-tracker.ts     # BudgetTracker — token and cost budgets
  ├── trace-graph.ts        # TraceGraph — visualizable delegation chains
  ├── run-timeline.ts       # RunTimeline — step-by-step execution view
  └── sinks/
      ├── json-sink.ts      # JSON file/stream sink
      └── console-sink.ts   # Enhanced console with tree rendering
```

#### 5I. geneWeave integration
**Admin UI tabs and DB tables for Phase 5 tool configuration:**

| Admin Tab | DB Table | Purpose |
|---|---|---|
| Search Providers | `search_providers` | Enable/disable search providers, API keys, rate limits, priority |
| HTTP Endpoints | `http_endpoints` | Registered REST API endpoints with auth configs, schemas, retry policies |
| Social Accounts | `social_accounts` | Connected social platform accounts, OAuth tokens, permissions |
| Enterprise Connectors | `enterprise_connectors` | SharePoint sites, Confluence spaces, email accounts, Drive configs |
| Tool Registry | `tool_registry` | All registered tools — risk level, health, enabled/disabled, MCP namespace |

**Chat integration:**
- Agent can invoke any registered MCP tool during conversation
- Tool calls show in chat as collapsible execution cards (tool name, input, output, duration)
- Search results render as rich link cards with title, snippet, source
- Social/enterprise results render with platform-specific formatting

**Seed data:**
- Default search provider configs (SearXNG local, DuckDuckGo as fallback)
- Sample HTTP endpoint (JSONPlaceholder for testing)
- Sample tool registry entries for all built-in tools

---

### Phase 6 — Replay, Event Triggers & Multi-Tenancy
**Priority: MEDIUM — production operations and testing at scale**

#### 6A. `@weaveintel/replay`
**Package structure:**
```
packages/replay/src/
  ├── index.ts              # Public API
  ├── engine.ts             # ReplayEngine — replays recorded runs
  ├── scenario.ts           # ReplayScenario, BenchmarkSuite
  ├── golden.ts             # GoldenCase — reference outputs for regression
  ├── comparison.ts         # ComparisonRun — A/B model/prompt comparison
  └── regression.ts         # EvalRegression — detect quality regressions
```

#### 6B. `@weaveintel/triggers`
**Package structure:**
```
packages/triggers/src/
  ├── index.ts              # Public API
  ├── trigger.ts            # EventTrigger, TriggerDefinition
  ├── cron.ts               # CronTrigger — scheduled execution
  ├── webhook.ts            # WebhookTrigger — HTTP-driven
  ├── queue.ts              # QueueTrigger — message-driven
  ├── change.ts             # ChangeTrigger — document/record change events
  └── binding.ts            # EventDrivenWorkflowBinding
```

#### 6C. `@weaveintel/tenancy`
**Package structure:**
```
packages/tenancy/src/
  ├── index.ts              # Public API
  ├── config.ts             # ConfigScope, OverrideLayer
  ├── resolver.ts           # ConfigResolver — effective config resolution
  ├── policy.ts             # TenantPolicy, EntitlementPolicy
  ├── capability-map.ts     # TenantCapabilityMap — per-tenant model/tool availability
  └── budget.ts             # Per-tenant budget enforcement
```

---

### Phase 7 — Sandbox, Extraction, Artifacts & Reliability
**Priority: MEDIUM — extended capabilities**

#### 7A. `@weaveintel/sandbox`
```
packages/sandbox/src/
  ├── index.ts              # Public API
  ├── sandbox.ts            # Sandbox — isolated execution environment
  ├── policy.ts             # SandboxPolicy — limits, restrictions
  ├── limits.ts             # ExecutionLimits — CPU, memory, time, network
  └── result.ts             # SandboxResult, ExecutionArtifact
```

#### 7B. `@weaveintel/extraction`
```
packages/extraction/src/
  ├── index.ts              # Public API
  ├── pipeline.ts           # DocumentTransformPipeline — ordered stages
  ├── stages/
  │   ├── metadata.ts       # Metadata normalization
  │   ├── language.ts       # Language detection
  │   ├── entities.ts       # Entity extraction
  │   ├── tables.ts         # Table extraction
  │   ├── code.ts           # Code block extraction
  │   ├── tasks.ts          # Task/deadline extraction
  │   └── timeline.ts       # Timeline extraction
  └── result.ts             # ExtractionResult, TransformationArtifact
```

#### 7C. `@weaveintel/artifacts`
```
packages/artifacts/src/
  ├── index.ts              # Public API
  ├── artifact.ts           # Artifact, ArtifactType, ArtifactVersion
  ├── store.ts              # ArtifactStore — pluggable storage
  ├── policy.ts             # ArtifactPolicy — retention, access
  └── reference.ts          # ArtifactReference — link to runs and provenance
```

#### 7D. `@weaveintel/reliability`
```
packages/reliability/src/
  ├── index.ts              # Public API
  ├── idempotency.ts        # IdempotencyPolicy — dedup by key
  ├── retry-budget.ts       # RetryBudget — bounded retry with backoff
  ├── dead-letter.ts        # DeadLetterRecord — failed operation capture
  ├── concurrency.ts        # ConcurrencyPolicy — rate limiting, semaphores
  ├── backpressure.ts       # BackpressureSignal — load shedding
  └── health.ts             # HealthStatus — readiness/liveness checks
```

---

### Phase 8 — Collaboration, Compliance, Graph & Plugins
**Priority: LOWER — advanced enterprise features**

#### 8A. `@weaveintel/collaboration`
```
packages/collaboration/src/
  ├── index.ts              # Public API
  ├── session.ts            # SharedSession, SessionParticipant
  ├── events.ts             # CollaborationEvent, PresenceState
  ├── subscription.ts       # RunSubscription — live status updates
  └── handoff.ts            # User handoff and presence coordination
```

#### 8B. `@weaveintel/compliance`
```
packages/compliance/src/
  ├── index.ts              # Public API
  ├── retention.ts          # RetentionRule — data lifecycle policies
  ├── deletion.ts           # DeletionRequest — right-to-delete
  ├── legal-hold.ts         # LegalHold — freeze deletion
  ├── residency.ts          # ResidencyConstraint — data location
  ├── consent.ts            # ConsentFlag — processing permissions
  └── audit-export.ts       # AuditExport — tenant-level export
```

#### 8C. `@weaveintel/graph`
```
packages/graph/src/
  ├── index.ts              # Public API
  ├── entity.ts             # EntityNode, RelationshipEdge
  ├── store.ts              # GraphMemoryStore — in-memory graph database
  ├── linker.ts             # EntityLinker — document-to-entity links
  ├── timeline.ts           # TimelineGraph — event ordering
  └── retriever.ts          # GraphRetriever — graph-assisted retrieval
```

#### 8D. `@weaveintel/plugins`
```
packages/plugins/src/
  ├── index.ts              # Public API
  ├── manifest.ts           # PluginManifest — metadata, capabilities, trust
  ├── registry.ts           # PluginRegistry — install, discover, validate
  ├── lifecycle.ts          # PluginLifecycle — init, start, stop hooks
  ├── compatibility.ts      # PluginCompatibilityResult — version checks
  └── installer.ts          # PluginInstaller — local/private/public
```

---

### Phase 9 — UI Primitives, DevTools & Recipes
**Priority: LOWER — developer experience and API polish**

#### 9A. `@weaveintel/ui-primitives`
```
packages/ui-primitives/src/
  ├── index.ts              # Public API
  ├── events.ts             # UiEvent, StreamEnvelope, ProgressUpdate
  ├── approval.ts           # ApprovalUiPayload
  ├── citations.ts          # CitationPayload — source attribution
  ├── artifacts.ts          # ArtifactPayload — rich output rendering
  └── widgets.ts            # WidgetPayload — interactive UI components
```

#### 9B. `@weaveintel/devtools`
```
packages/devtools/src/
  ├── index.ts              # Public API
  ├── scaffold.ts           # ProjectScaffold — create new projects
  ├── inspector.ts          # DevInspector — runtime capability inspection
  ├── validator.ts          # ConfigValidator — validate configs before run
  ├── mock-runtime.ts       # MockRuntime — full fake runtime for local dev
  └── migration.ts          # MigrationPlan — version upgrade helpers
```

#### 9C. `@weaveintel/recipes`
**Batteries-included compositions:**
```
packages/recipes/src/
  ├── index.ts
  ├── createWorkflowAgent.ts
  ├── createGovernedAssistant.ts
  ├── createApprovalDrivenAgent.ts
  ├── createAclAwareRagApp.ts
  ├── createMultiTenantRuntime.ts
  ├── createEvalRoutedAssistant.ts
  ├── createMemoryGovernedAssistant.ts
  ├── createEventDrivenAgent.ts
  └── createSafeExecutionAgent.ts
```

---

## 6. Immediate Refactors Needed

Before Phase 1 implementation, address these in the existing codebase:

| Refactor | Package | Why |
|---|---|---|
| Extract policy types from `redaction` into `core/security.ts` | core, redaction | Policy engine is general-purpose, not redaction-specific |
| Add `WorkflowStep` and `WorkflowEvent` to core event types | core | Workflows need their own event category |
| Add `ToolRiskLevel` and `ToolCategory` to `core/tools.ts` | core | Tool lifecycle needs risk metadata in the base type |
| Extend `ExecutionContext` with `workflowRunId` and `checkpointId` | core | Workflow steps need to reference their execution context |
| Add `HumanDecision` and `ApprovalStatus` to core events | core | Human tasks need standard event types |
| Extend `PluginRegistry` in core with lifecycle hooks | core | Current plugin registry is basic; needs init/start/stop |
| Add prompt-related event types to `EventTypes` | core | Prompt resolution should emit observable events |

---

## 7. First Code Files to Create/Update

**In order of implementation:**

1. **`packages/core/src/workflows.ts`** — Workflow interfaces
2. **`packages/core/src/guardrails.ts`** — Guardrail interfaces
3. **`packages/core/src/human-tasks.ts`** — Human task interfaces
4. **`packages/core/src/contracts.ts`** — Completion contract interfaces
5. **`packages/core/src/index.ts`** — Re-export new modules
6. **`packages/workflows/package.json`** — New package setup
7. **`packages/workflows/src/engine.ts`** — Workflow engine runtime
8. **`packages/workflows/src/definition.ts`** — Workflow definition builder
9. **`packages/workflows/src/steps.ts`** — Step type implementations
10. **`packages/workflows/src/state.ts`** — State management and checkpointing
11. **`packages/guardrails/package.json`** — New package setup
12. **`packages/guardrails/src/pipeline.ts`** — Guardrail pipeline
13. **`packages/guardrails/src/guardrail.ts`** — Built-in guardrails

---

## 8. First End-to-End Example

**`examples/13-governed-workflow.ts`** — Proves the direction by combining Phase 1 and Phase 2 capabilities:

```typescript
// Example: A document processing workflow with guardrails and human approval

import { weaveContext } from '@weaveintel/core';
import { weaveWorkflow, step, agenticStep, approvalStep, branch } from '@weaveintel/workflows';
import { weaveGuardrailPipeline, inputGuardrail, outputGuardrail } from '@weaveintel/guardrails';
import { weaveFakeModel } from '@weaveintel/testing';

const model = weaveFakeModel({ responses: ['Classification: financial-report'] });

// Define guardrails
const guardrails = weaveGuardrailPipeline({
  pre: [inputGuardrail.maxLength(10000), inputGuardrail.noBlockedPhrases(['DROP TABLE'])],
  post: [outputGuardrail.notEmpty(), outputGuardrail.noHarmfulContent()],
});

// Define workflow
const workflow = weaveWorkflow({
  name: 'document-processor',
  steps: [
    step('validate', async (ctx, input) => {
      const result = await guardrails.evaluatePre(ctx, input.document);
      if (!result.allowed) throw new Error(result.reason);
      return { document: input.document };
    }),

    agenticStep('classify', { model, goal: 'Classify the document type' }),

    branch('route', (ctx, state) => {
      if (state.classify.output.includes('financial')) return 'review';
      return 'summarize';
    }),

    approvalStep('review', {
      description: 'Financial document requires human review',
      assignee: 'compliance-team',
      slaMs: 3600_000, // 1 hour
    }),

    agenticStep('summarize', { model, goal: 'Summarize the document' }),

    step('output', async (ctx, state) => {
      const result = await guardrails.evaluatePost(ctx, state.summarize?.output ?? state.review?.decision);
      return { summary: result.content, approved: true };
    }),
  ],
});

// Run
const ctx = weaveContext({ userId: 'user-1' });
const run = await workflow.start(ctx, { document: 'Q4 2025 Financial Report...' });
console.log('Run state:', run.state);
console.log('Run status:', run.status); // 'waiting_approval' or 'completed'
```

---

## 9. First Test Plan

### Unit tests to write first

| Test File | Covers | Priority |
|---|---|---|
| `packages/workflows/src/__tests__/engine.test.ts` | Workflow creation, linear execution, step result passing | P0 |
| `packages/workflows/src/__tests__/branching.test.ts` | Conditional branching, loop execution | P0 |
| `packages/workflows/src/__tests__/checkpoint.test.ts` | State serialization, resume from checkpoint | P0 |
| `packages/workflows/src/__tests__/agentic-step.test.ts` | Agentic steps with fake model, tool calling in workflows | P0 |
| `packages/workflows/src/__tests__/compensation.test.ts` | Rollback on failure, compensation handlers | P1 |
| `packages/guardrails/src/__tests__/pipeline.test.ts` | Pre/mid/post evaluation, short-circuit on deny | P0 |
| `packages/guardrails/src/__tests__/risk.test.ts` | Risk scoring, confidence gating | P1 |
| `packages/guardrails/src/__tests__/cost-guard.test.ts` | Token ceiling, cost budget enforcement | P0 |

### Integration tests

| Test | Covers | Priority |
|---|---|---|
| Workflow + agent step | Agent runs inside workflow, results flow to next step | P0 |
| Workflow + human approval | Workflow pauses, external decision resumes it | P0 |
| Guardrail + agent | Agent output checked by guardrail, denied output triggers retry | P0 |
| Workflow + guardrail | Pre-step guardrails gate execution | P1 |

### New fakes needed (extend `@weaveintel/testing`)

| Fake | Purpose |
|---|---|
| `weaveFakeCheckpointStore()` | In-memory workflow checkpoint store for tests |
| `weaveFakeGuardrail()` | Configurable allow/deny guardrail for tests |
| `weaveFakePolicyEngine()` | Rule-based policy engine returning canned decisions |
| `weaveFakePromptRegistry()` | Static prompt registry for tests |
| `weaveFakeHumanTaskQueue()` | Auto-approving human task queue for tests |

---

## Appendix A: Implementation Checklist Per Capability

For every new capability, verify:

- [ ] Interfaces defined in `@weaveintel/core`
- [ ] Implementation in dedicated package
- [ ] Events emitted to event bus
- [ ] Telemetry integrated (tracing)
- [ ] Configuration via `ExecutionContext` or dedicated config
- [ ] No vendor lock-in
- [ ] Unit tests with fakes
- [ ] Integration test with at least one other subsystem
- [ ] At least one runnable example
- [ ] Exported from package `index.ts`
- [ ] Added to root `package.json` workspaces (if new package)
- [ ] Added to `tsconfig.json` references
- [ ] README.md for the package

---

## Appendix B: Cross-Cutting Concerns

These apply to every phase:

| Concern | Approach |
|---|---|
| **Observability** | Every subsystem emits typed events via `weaveEventBus`. New event types added to `EventTypes`. |
| **Configuration** | Config objects for every subsystem. No magic globals. |
| **Testing** | Every implementation has corresponding fake in `@weaveintel/testing`. |
| **Error Handling** | All errors use `WeaveIntelError` with retry semantics. |
| **Context Propagation** | All operations accept `ExecutionContext` for tenant/user/deadline/budget. |
| **Middleware** | Where applicable, subsystems support middleware pipelines. |
| **Serialization** | Workflow state, prompts, policies — all JSON-serializable for persistence. |

---

## Appendix C: Documentation Plan

| Document | Phase | Covers |
|---|---|---|
| `docs/architecture.md` | Phase 0 | System overview, package map, dependency graph |
| `docs/workflows.md` | Phase 1 | Workflow runtime, step types, checkpointing, resumability |
| `docs/guardrails.md` | Phase 1 | Guardrail pipeline, risk scoring, policy configuration |
| `docs/human-tasks.md` | Phase 2 | Approval flows, review queues, escalation |
| `docs/contracts.md` | Phase 2 | Task contracts, completion validation, evidence |
| `docs/prompts.md` | Phase 3 | Prompt templates, versioning, A/B testing |
| `docs/routing.md` | Phase 3 | Model routing, health, cost optimization |
| `docs/caching.md` | Phase 4 | Semantic cache, TTL, invalidation |
| `docs/memory-governance.md` | Phase 4 | Provenance, dedup, forgetting, write policies |
| `docs/identity.md` | Phase 4 | Runtime identity, delegation, scoped secrets |
| `docs/tools.md` | Phase 5 | Tool risk, versioning, test harnesses |
| `docs/retrieval-advanced.md` | Phase 5 | Hybrid retrieval, ACL, multi-hop, citations |
| `docs/observability.md` | Phase 5 | OTLP, trace graphs, budget tracking |
| `docs/replay.md` | Phase 6 | Replay engine, golden datasets, regression |
| `docs/triggers.md` | Phase 6 | Cron, webhook, queue, change triggers |
| `docs/tenancy.md` | Phase 6 | Config inheritance, entitlements, budgets |
| `docs/sandbox.md` | Phase 7 | Isolated execution, resource limits |
| `docs/extraction.md` | Phase 7 | Document pipelines, entity/table/task extraction |
| `docs/artifacts.md` | Phase 7 | Typed outputs, versioning, provenance |
| `docs/reliability.md` | Phase 7 | Idempotency, retry budgets, dead letters |
| `docs/collaboration.md` | Phase 8 | Shared sessions, presence, live updates |
| `docs/compliance.md` | Phase 8 | Retention, deletion, legal hold, consent |
| `docs/graph.md` | Phase 8 | Entity graph, relationships, graph retrieval |
| `docs/plugins.md` | Phase 8 | Plugin authoring, manifest, lifecycle |
| `docs/ui-primitives.md` | Phase 9 | Structured UI events, approvals, citations |
| `docs/devtools.md` | Phase 9 | CLI, scaffolding, inspection, mocks |
| `docs/recipes.md` | Phase 9 | Batteries-included compositions, quick starts |
