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
  createCapabilitySet as weaveCapabilities,
} from './capabilities.js';

// Execution context
export {
  type ExecutionContext,
  type ExecutionBudget,
  createExecutionContext as weaveContext,
  childContext as weaveChildContext,
  isExpired,
  deadlineSignal,
  withTimeoutSignal,
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
  createEventBus as weaveEventBus,
  createEvent as weaveEvent,
} from './events.js';

// Middleware pipeline
export {
  type Middleware,
  Pipeline as WeavePipeline,
  composeMiddleware as weaveMiddleware,
  timeoutMiddleware as weaveTimeout,
  retryMiddleware as weaveRetry,
} from './middleware.js';

// Plugin registry
export {
  type PluginDescriptor,
  type PluginType,
  type Plugin,
  type PluginRegistry,
  createPluginRegistry as weavePluginRegistry,
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
  createToolRegistry as weaveToolRegistry,
  defineTool as weaveTool,
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
  type WorkingMemoryPatch,
  type WorkingMemorySnapshot,
  type WorkingMemory,
  type CompressionInput,
  type CompressionArtefact,
  type ContextCompressor,
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
  type CapabilityKind,
  type CapabilityEvaluationTelemetry,
  type CapabilityContractTelemetry,
  type CapabilityTelemetrySummary,
  type CapabilityTelemetryStage,
  type UsageRecord,
  type UsageTracker,
  type RunLog,
  type StepLog,
} from './observability.js';
export {
  setDefaultTracer as weaveSetDefaultTracer,
  getDefaultTracer as weaveGetDefaultTracer,
  resolveTracer as weaveResolveTracer,
} from './observability-runtime.js';

// Admin capability schema helpers
export {
  type AdminFieldSaveTransform,
  type AdminFieldDef,
  type AdminTabDef,
  type AdminTabGroup,
  type AdminTabMap,
  normalizeAdminTabsForModelDiscovery,
} from './admin-capabilities.js';

// MCP contracts
export {
  type MCPToolDefinition,
  type MCPToolCallRequest,
  type MCPToolCallResponse,
  type MCPContent,
  type MCPStreamEventType,
  type MCPStreamEvent,
  type MCPToolCallStreamOptions,
  type MCPCapabilityKind,
  type MCPCapabilitySummary,
  type MCPCapabilityDetails,
  type MCPCapabilityDiscoveryQuery,
  type MCPCapabilityDiscoveryPage,
  type MCPComposableCallStep,
  type MCPComposableCallPlan,
  type MCPComposableStepResult,
  type MCPComposableCallResult,
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

// Responses API contracts (agentic loop)
export {
  type ResponseModel,
  type ResponseRequest,
  type ResponseResult,
  type ResponseInputItem,
  type ResponseOutputItem,
  type ResponseToolDefinition,
  type ResponseStreamEvent,
  type ResponseTextFormat,
} from './responses.js';

// File storage contracts
export {
  type FileStorage,
  type FileUploadRequest,
  type FileObject,
  type FilePurpose,
  type FileListOptions,
} from './files.js';

// Moderation contracts
export {
  type ModerationModel,
  type ModerationRequest,
  type ModerationResponse,
  type ModerationResult,
  type ModerationCategory,
  type ModerationInput,
} from './moderation.js';

// Fine-tuning contracts
export {
  type FineTuningProvider,
  type FineTuneRequest,
  type FineTuneJob,
  type FineTuneEvent,
  type FineTuneStatus,
  type FineTuneHyperparameters,
  type FineTuneListOptions,
} from './finetuning.js';

// Managed vector store contracts
export {
  type ManagedVectorStore,
  type ManagedVectorStoreConfig,
  type ManagedVectorStoreInfo,
  type ManagedVectorStoreFile,
  type ManagedVectorSearchOptions,
  type ManagedVectorSearchResult,
  type ManagedChunkingStrategy,
  type ManagedFileBatch,
} from './managed-vectorstore.js';

// Workflow orchestration contracts
export {
  type WorkflowStepType,
  type WorkflowStep,
  type WorkflowDefinition,
  type WorkflowRunStatus,
  type WorkflowState,
  type WorkflowStepResult,
  type WorkflowRun,
  type WorkflowCheckpoint,
  type WorkflowTriggerType,
  type WorkflowTrigger,
  type WorkflowScheduler,
  type WorkflowPolicy,
  type WorkflowCompensation,
  type WorkflowEventType,
  type WorkflowEvent,
  type ApprovalStatus,
  type WorkflowApprovalTask,
  type WorkflowEngine,
} from './workflows.js';

// Guardrail & governance contracts
export {
  type GuardrailDecision,
  type GuardrailStage,
  type GuardrailType,
  type GuardrailResult,
  type GuardrailEvaluationContext,
  type Guardrail,
  type GuardrailPipeline,
  type RiskLevel,
  type RiskClassifier,
  type ConfidenceGate,
  type ActionGate,
  type GovernanceRule,
  type GovernanceContext,
  type RuntimePolicy,
} from './guardrails.js';

// Human-in-the-loop contracts
export {
  type HumanTaskStatus,
  type HumanTaskType,
  type HumanTaskPriority,
  type HumanTask,
  type ApprovalTask,
  type ReviewTask,
  type EscalationTask,
  type HumanDecision,
  type HumanTaskQueue,
  type HumanTaskFilter,
  type HumanTaskPolicy,
} from './human-tasks.js';

// Completion contracts
export {
  type TaskContract,
  type AcceptanceCriteria,
  type CompletionContract,
  type CompletionReport,
  type ValidationResult,
  type EvidenceBundle,
  type EvidenceItem,
  type TaskOutcomeStatus,
  type TaskOutcome,
  type FailureReason,
  type CompletionValidator,
} from './contracts.js';

// Prompt management contracts
export {
  type PromptDefinition,
  type PromptKind,
  type PromptStatus,
  type PromptVersion,
  type PromptVersionBase,
  type PromptVariable,
  type PromptVariableType,
  type PromptTemplate,
  type PromptRegistry,
  type InstructionBundle,
  type PromptVariant,
  type PromptExperiment,
  type PromptResolver,
  type PromptOwner,
  type PromptModelCompatibility,
  type PromptExecutionDefaults,
  type PromptFrameworkSection,
  type PromptFrameworkRef,
  type PromptOutputContractRef,
  type PromptExample,
  type PromptRoute,
  type PromptChainStep,
  type StructuredPromptMessage,
  type TemplatePromptVersion,
  type FewShotPromptVersion,
  type StructuredPromptVersion,
  type ChainPromptVersion,
  type RouterPromptVersion,
  type JudgePromptVersion,
  type OptimizerPromptVersion,
  type ModalityPresetPromptVersion,
} from './prompts.js';

// LLM-callable component contracts
export {
  type CallableKind,
  type CallableDescriptor,
  type CallableDescriptionValidationOptions,
  type CallableDescriptionValidationResult,
  normalizeCallableDescription,
  validateCallableDescription,
} from './callables.js';

// Model routing contracts
export {
  type RoutingDecision,
  type RoutingStrategy,
  type RoutingPolicy,
  type RoutingConstraints,
  type ModelHealth,
  type ModelScore,
  type RoutingContext,
  type ModelRouter,
  type FallbackPlan,
  type OutputModality,
  type OptimisationStrategy,
  type TaskTypeInferenceSource,
  type TaskTypeInferenceHints,
  type ToolDescriptor as RoutingToolDescriptor,
  type ModelCapabilityRow,
} from './routing.js';

// Cache contracts
export {
  type CacheStore,
  type SemanticCache,
  type SemanticCacheHit,
  type CacheScopeType,
  type CachePolicy,
  type CacheKeyBuilder,
  type CacheInvalidationRule,
  type CacheScope,
} from './cache.js';

// Identity & access contracts
export {
  type RuntimeIdentity,
  type IdentityContext,
  type DelegationContext,
  type AccessDecisionResult,
  type PermissionDescriptor,
  type AccessDecision,
  type SecretScope,
  type AccessTokenResolver,
} from './identity.js';

// Tool lifecycle contracts
export {
  type ToolRiskLevel,
  type ToolDescriptor,
  type ToolVersion,
  type ToolLifecyclePolicy,
  type ToolTestCase,
  type ToolTestResult,
  type ToolTestHarness,
  type ToolHealth,
  type ToolExecutionPolicy,
  type ToolPolicyViolationReason,
  type EffectiveToolPolicy,
  type ToolAuditOutcome,
  type ToolAuditEvent,
} from './tool-lifecycle.js';

// Replay & evaluation contracts
export {
  type ReplayScenario,
  type ReplayEngine,
  type ReplayResult,
  type BenchmarkSuite,
  type EvalScenario,
  type EvalRegression,
  type RegressionItem,
  type ComparisonRun,
  type GoldenCase,
  type RunArtifact,
} from './replay.js';

// Event trigger contracts
export {
  type TriggerType,
  type TriggerDefinition,
  type EventTrigger,
  type TriggerSubscription,
  type EventEnvelope,
  type TriggerHandler,
  type EventDrivenWorkflowBinding,
} from './triggers.js';

// Multi-tenancy contracts
export {
  type ConfigScopeLevel,
  type ConfigScope,
  type EffectiveConfig,
  type ConfigResolver,
  type OverrideLayer,
  type EntitlementPolicy,
  type TenantPolicy,
  type TenantCapabilityMap,
} from './tenancy.js';

// Sandbox contracts
export {
  type Sandbox,
  type SandboxPolicy,
  type ExecutionLimits,
  type SandboxResult,
  type ExecutionArtifact,
  type RestrictedEnvironment,
} from './sandbox.js';

// Document extraction contracts
export {
  type DocumentTransformPipeline,
  type DocumentInput,
  type ExtractionStageType,
  type ExtractionStage,
  type ExtractedEntity,
  type ExtractedTask,
  type ExtractedTimeline,
  type ExtractionResult,
  type TransformationArtifact,
} from './extraction.js';

// Collaboration contracts
export {
  type SharedSession,
  type SessionParticipant,
  type CollaborationEventType,
  type CollaborationEvent,
  type SharedContext,
  type RunSubscription,
  type PresenceState,
} from './collaboration.js';

// Plugin system contracts
export {
  type PluginManifest,
  type PluginCapability,
  type PluginCompatibilityResult,
  type PluginTrustLevel,
  type PluginLifecycle,
  type PluginInstaller,
} from './plugins.js';

// Artifact contracts
export {
  type ArtifactType,
  type Artifact,
  type ArtifactVersion,
  type ArtifactStore,
  type ArtifactReference,
  type ArtifactPolicy,
} from './artifacts.js';

// Reliability contracts
export {
  type IdempotencyPolicy,
  type RetryBudget,
  type DeadLetterRecord,
  type ConcurrencyPolicy,
  type BackpressureSignal,
  type HealthStatusState,
  type HealthStatus,
  type HealthCheck,
  type FailureEnvelope,
} from './reliability.js';

// Compliance contracts
export {
  type CompliancePolicy,
  type RetentionRule,
  type DeletionStatus,
  type DeletionRequest,
  type LegalHold,
  type ResidencyConstraint,
  type AuditExport,
  type ConsentFlag,
} from './compliance.js';

// Knowledge graph contracts
export {
  type EntityNode,
  type RelationshipEdge,
  type GraphMemoryStore,
  type EntityLinker,
  type TimelineGraph,
  type GraphRetriever,
} from './graph.js';

// UI event contracts
export {
  type UiEventType,
  type UiEvent,
  type StreamEnvelope,
  type ProgressUpdate,
  type ApprovalUiPayload,
  type CitationPayload,
  type ArtifactPayload,
  type WidgetType,
  type WidgetPayload,
} from './ui-events.js';
