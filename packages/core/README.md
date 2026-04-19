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
