/**
 * @weaveintel/core — Capability system
 *
 * Why: Capability-based contracts replace inheritance hierarchies.
 * A model/connector/agent declares what it can do. Consumers query capabilities
 * at runtime without provider-specific branching.
 *
 * This is the single most important pattern in the framework. It prevents lock-in
 * and allows the ecosystem to grow without changing core abstractions.
 */

/** A capability identifier — namespaced string like "model.chat" or "connector.search" */
export type CapabilityId = string & { readonly __brand: unique symbol };

export function capabilityId(id: string): CapabilityId {
  return id as CapabilityId;
}

/** Standard capability identifiers */
export const Capabilities = {
  // Model capabilities
  Chat: capabilityId('model.chat'),
  Reasoning: capabilityId('model.reasoning'),
  ToolCalling: capabilityId('model.tool_calling'),
  StructuredOutput: capabilityId('model.structured_output'),
  Streaming: capabilityId('model.streaming'),
  Embedding: capabilityId('model.embedding'),
  Reranking: capabilityId('model.reranking'),
  Audio: capabilityId('model.audio'),
  ImageGeneration: capabilityId('model.image_generation'),
  ImageEditing: capabilityId('model.image_editing'),
  Vision: capabilityId('model.vision'),
  Multimodal: capabilityId('model.multimodal'),

  // Connector capabilities
  ConnectorList: capabilityId('connector.list'),
  ConnectorRead: capabilityId('connector.read'),
  ConnectorSearch: capabilityId('connector.search'),
  ConnectorWatch: capabilityId('connector.watch'),
  ConnectorSync: capabilityId('connector.sync'),
  ConnectorPermissions: capabilityId('connector.permissions'),
  ConnectorContentExtract: capabilityId('connector.content_extract'),
  ConnectorMetadataExtract: capabilityId('connector.metadata_extract'),
  ConnectorWrite: capabilityId('connector.write'),

  // Vector store capabilities
  VectorSearch: capabilityId('vector.search'),
  VectorUpsert: capabilityId('vector.upsert'),
  VectorDelete: capabilityId('vector.delete'),
  VectorFilter: capabilityId('vector.filter'),
  VectorHybrid: capabilityId('vector.hybrid'),

  // Memory capabilities
  MemoryConversation: capabilityId('memory.conversation'),
  MemorySemantic: capabilityId('memory.semantic'),
  MemoryEpisodic: capabilityId('memory.episodic'),
  MemoryEntity: capabilityId('memory.entity'),

  // Responses / Agentic loop capabilities
  Responses: capabilityId('model.responses'),
  WebSearch: capabilityId('model.web_search'),
  FileSearch: capabilityId('model.file_search'),
  CodeInterpreter: capabilityId('model.code_interpreter'),
  ComputerUse: capabilityId('model.computer_use'),

  // File & storage capabilities
  FileUpload: capabilityId('storage.file_upload'),
  FileDownload: capabilityId('storage.file_download'),

  // Managed vector store capabilities
  ManagedVectorStore: capabilityId('vector.managed'),
  ManagedVectorSearch: capabilityId('vector.managed_search'),

  // Moderation capabilities
  Moderation: capabilityId('moderation.classify'),

  // Fine-tuning capabilities
  FineTuning: capabilityId('model.fine_tuning'),

  // Agent capabilities
  AgentPlanning: capabilityId('agent.planning'),
  AgentToolUse: capabilityId('agent.tool_use'),
  AgentDelegation: capabilityId('agent.delegation'),
  AgentReflection: capabilityId('agent.reflection'),
} as const;

/** Metadata about a specific capability */
export interface CapabilityDescriptor {
  readonly id: CapabilityId;
  readonly version?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Anything that declares capabilities */
export interface HasCapabilities {
  readonly capabilities: ReadonlySet<CapabilityId>;
  hasCapability(id: CapabilityId): boolean;
}

/** Mixin to implement HasCapabilities */
export function createCapabilitySet(...ids: CapabilityId[]): HasCapabilities {
  const set = new Set(ids) as ReadonlySet<CapabilityId>;
  return {
    capabilities: set,
    hasCapability(id: CapabilityId): boolean {
      return set.has(id);
    },
  };
}
