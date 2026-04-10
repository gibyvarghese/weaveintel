// @weaveintel/core — Public API
// The core package exports all contracts, types, and runtime utilities.
// It has ZERO vendor dependencies. Provider packages depend on core, never the reverse.

// Capability system
export {
  type CapabilityId,
  type CapabilityDescriptor,
  type HasCapabilities,
  Capabilities,
  capabilityId,
  createCapabilitySet,
} from './capabilities.js';

// Execution context
export {
  type ExecutionContext,
  type ExecutionBudget,
  createExecutionContext,
  childContext,
  isExpired,
  deadlineSignal,
} from './context.js';

// Error model
export {
  type ErrorCode,
  WeaveIntelError,
  normalizeError,
} from './errors.js';

// Event system
export {
  type WeaveEvent,
  type EventHandler,
  type EventFilter,
  type EventBus,
  type Unsubscribe,
  EventTypes,
  createEventBus,
  createEvent,
} from './events.js';

// Middleware pipeline
export {
  type Middleware,
  Pipeline,
  composeMiddleware,
  timeoutMiddleware,
  retryMiddleware,
} from './middleware.js';

// Plugin registry
export {
  type PluginDescriptor,
  type PluginType,
  type Plugin,
  type PluginRegistry,
  createPluginRegistry,
} from './registry.js';

// Model contracts
export {
  type Role,
  type TextContent,
  type ImageContent,
  type AudioContent,
  type FileContent,
  type ContentPart,
  type Message,
  type ToolDefinition,
  type ToolCall,
  type ToolResult,
  type JsonSchema,
  type ResponseFormat,
  type ModelRequest,
  type ModelResponse,
  type TokenUsage,
  type StreamChunk,
  type ModelStream,
  type ModelInfo,
  type Model,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type EmbeddingModel,
  type RerankRequest,
  type RerankResult,
  type RerankResponse,
  type RerankerModel,
  type ImageGenerationRequest,
  type GeneratedImage,
  type ImageGenerationResponse,
  type ImageModel,
  type SpeechRequest,
  type TranscriptionRequest,
  type AudioModel,
} from './models.js';

// Tool contracts
export {
  type ToolSchema,
  type ToolInput,
  type ToolOutput,
  type Tool,
  type ToolPolicy,
  type PolicyDecision,
  type ToolRegistry,
  createToolRegistry,
  defineTool,
} from './tools.js';

// Document contracts
export {
  type Document,
  type DocumentChunk,
  type DocumentMetadata,
  type SourceReference,
  type Provenance,
  type AccessPolicy,
} from './documents.js';

// Connector contracts
export {
  type ConnectorConfig,
  type ConnectorAuth,
  type ConnectorListOptions,
  type ConnectorListResult,
  type ConnectorListItem,
  type ConnectorReadOptions,
  type ConnectorSearchOptions,
  type ConnectorWatchEvent,
  type Connector,
  type ListableConnector,
  type ReadableConnector,
  type SearchableConnector,
  type WatchableConnector,
  type SyncableConnector,
  isListable,
  isReadable,
  isSearchable,
  isWatchable,
  isSyncable,
} from './connectors.js';

// Vector store & retrieval contracts
export {
  type VectorStoreConfig,
  type VectorRecord,
  type VectorSearchOptions,
  type VectorSearchResult,
  type VectorStore,
  type RetrievalQuery,
  type RetrievalResult,
  type Retriever,
  type ChunkingStrategy,
  type ChunkerConfig,
  type Chunker,
  type IndexerConfig,
  type Indexer,
} from './vectorstore.js';

// Agent contracts
export {
  type AgentConfig,
  type AgentInput,
  type AgentResult,
  type AgentStep,
  type AgentUsage,
  type Agent,
  type AgentStepEvent,
  type SupervisorConfig,
  type DelegationRequest,
  type DelegationResult,
  type AgentRuntime,
  type AgentMemory,
  type AgentPolicy,
} from './agents.js';

// Memory contracts
export {
  type MemoryEntry,
  type MemoryType,
  type MemoryStore,
  type MemoryQuery,
  type MemoryFilter,
  type MemoryPolicy,
  type MemoryRetentionPolicy,
  type ConversationMemory,
  type SemanticMemory,
  type EntityMemory,
} from './memory.js';

// Security contracts
export {
  type RedactionResult,
  type Detection,
  type Redactor,
  type RedactionPolicy,
  type RedactionPattern,
  type ClassificationResult,
  type ClassificationLabel,
  type ContentClassifier,
  type PolicyEvaluation,
  type PolicyRule,
  type PolicyInput,
  type PolicyEngine,
  type AccessEvaluator,
  type AuditEntry,
  type AuditLogger,
  type SecretResolver,
} from './security.js';

// Observability contracts
export {
  type Span,
  type Tracer,
  type TraceSink,
  type SpanRecord,
  type SpanEvent,
  type UsageRecord,
  type UsageTracker,
  type RunLog,
  type StepLog,
} from './observability.js';

// MCP contracts
export {
  type MCPToolDefinition,
  type MCPToolCallRequest,
  type MCPToolCallResponse,
  type MCPContent,
  type MCPResource,
  type MCPResourceContent,
  type MCPPrompt,
  type MCPPromptArgument,
  type MCPPromptMessage,
  type MCPTransport,
  type MCPClient,
  type MCPServerConfig,
  type MCPServer,
  type MCPToolHandler,
  type MCPResourceHandler,
  type MCPPromptHandler,
} from './mcp.js';

// A2A contracts
export {
  type AgentCard,
  type AgentSkill,
  type AgentAuthentication,
  type A2ATask,
  type A2AMessage,
  type A2APart,
  type A2ATaskStatus,
  type A2ATaskResult,
  type A2AClient,
  type A2AServer,
  type InternalA2ABus,
} from './a2a.js';

// Eval contracts
export {
  type EvalDefinition,
  type EvalType,
  type Assertion,
  type AssertionType,
  type EvalCase,
  type EvalResult,
  type AssertionResult,
  type EvalSuiteResult,
  type EvalRunner,
} from './evals.js';
