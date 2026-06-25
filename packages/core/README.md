# @weaveintel/core

Core contracts, types, and runtime primitives for the weaveIntel AI framework.

**This package has zero vendor dependencies.** It defines the interfaces that all other packages implement or consume.

## What's Inside

### Capability System
- `CapabilityId`, `Capabilities` — standard capability identifiers (Chat, Embedding, Streaming, ToolCalling, Vision, etc.)
- `HasCapabilities`, `createCapabilitySet()` — runtime capability checking

### Execution Context
- `ExecutionContext` — carries userId, traceId, budget, deadline, and abort signal through every call
- `createExecutionContext()`, `childContext()`, `isExpired()`, `deadlineSignal()`

### Model Contracts
- `Model` — `generate()` + optional `stream()`, extends `HasCapabilities`
- `EmbeddingModel` — `embed()` for vector embeddings
- `RerankerModel`, `ImageModel`, `AudioModel` — specialized model contracts
- `ModelRequest`, `ModelResponse`, `StreamChunk`, `ModelStream`, `TokenUsage`

### Tool System
- `Tool`, `ToolRegistry`, `ToolSchema` — typed tool definitions
- `defineTool()` — convenience factory
- `createToolRegistry()` — in-memory registry with lookup

### Middleware & Pipeline
- `Middleware<T, R>` — generic middleware type
- `composeMiddleware()` — compose middleware chain into a single handler
- `Pipeline<T, R>` — class-based pipeline builder
- `timeoutMiddleware()`, `retryMiddleware()` — built-in middleware

### Event System
- `EventBus`, `WeaveEvent`, `EventTypes` — 30+ standard event types
- `createEventBus()`, `createEvent()` — factory functions

### Documents & Retrieval
- `Document`, `DocumentChunk`, `DocumentMetadata`, `Provenance`
- `VectorStore`, `VectorRecord`, `Retriever`, `Chunker`, `ChunkingStrategy`
- `Connector` hierarchy — `Listable`, `Readable`, `Searchable`, `Watchable`, `Syncable`

### Agent Contracts
- `Agent`, `AgentConfig`, `AgentInput`, `AgentResult`, `AgentStep`
- `Supervisor`, `DelegationRequest`, `DelegationResult`

### Memory
- `MemoryStore`, `MemoryEntry`, `MemoryType`
- `ConversationMemory`, `SemanticMemory`, `EntityMemory`

### Security
- `Redactor`, `RedactionResult`, `Detection`, `RedactionPolicy`
- `ContentClassifier`, `PolicyEngine`, `AuditLogger`, `SecretResolver`

### Observability
- `Tracer`, `Span`, `TraceSink`, `SpanRecord`
- `UsageTracker`, `UsageRecord`, `RunLog`, `StepLog`

### Admin Capability Schema (Phase 9)
- `AdminFieldDef`, `AdminTabDef`, `AdminTabGroup`, `AdminTabMap` — shared schema contracts for DB-driven admin capability UIs
- `normalizeAdminTabsForModelDiscovery()` — enforces model-facing description labels for LLM-callable entities (prompts, skills, tools, workers)
- Used by GeneWeave admin schema composition to reduce app-local duplication and keep metadata quality consistent

### Run substrate (Collaboration Phase 0)
The canonical run-lifecycle contracts, relocated here from `@weaveintel/collaboration`
so there is ONE registry/journal interface with interchangeable backends (a KV
reference adapter here; a SQL adapter in geneWeave), each proven by the same
shared conformance suite.
- **Run registry** — `RunRegistry` (port), `createKvRunRegistry()` (KV adapter): durable run-handle store; tenant-isolated; idempotent status updates; lifecycle events.
- **Run journal** — `RunJournal` (port), `createKvRunJournal()` (KV adapter): append-only, sequenced, resumable-by-cursor run-event log. `readAfter(N)` is **exclusive** (returns `sequence > N`) and **gap-safe** (throws `RunCursorTooOldError` if the cursor fell below the retained watermark). Defaults (`RUN_JOURNAL_DEFAULTS`) derive from `RUN_STREAM_CONFIG_DEFAULTS` — one source for retention/size.
- **Conformance** — `runRegistryContract()` / `runJournalContract()`: shared test suites every adapter (KV here, SQL in geneWeave) must pass.

### SSE parsing
- `parseSseStream(stream, opts)` — the single, WHATWG-correct, browser-safe
  Server-Sent-Events byte→event decoder (`SseEvent`, `ParseSseOptions`,
  `SseStallError`). De-duplicated from `@weaveintel/client` + `@weaveintel/a2a`
  (which now consume this one). Handles LF/CRLF, multi-line `data:`, comments,
  UTF-8 chunk boundaries, an optional stall timeout, and abort/cancel.

### Protocol Contracts
- **MCP:** `MCPClient`, `MCPServer`, `MCPToolDefinition`, `MCPResource`, `MCPPrompt`, `MCPTransport`
- **A2A:** `A2AClient`, `A2AServer`, `A2ATask`, `AgentCard`, `AgentSkill`, `InternalA2ABus`

### Error Handling
- `WeaveIntelError` — typed error with `code`, `retryable`, `details`
- `normalizeError()` — normalize unknown errors to WeaveIntelError
- 20+ error codes: `RATE_LIMITED`, `TIMEOUT`, `INVALID_CONFIG`, `TOOL_EXECUTION_FAILED`, etc.

### Plugin Registry
- `PluginRegistry`, `PluginDescriptor`, `PluginType`
- `createPluginRegistry()` — register and query plugins by type
