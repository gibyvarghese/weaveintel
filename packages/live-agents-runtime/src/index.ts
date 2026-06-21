// SPDX-License-Identifier: MIT
/**
 * @weaveintel/live-agents-runtime
 *
 * Generic, DB-driven runtime layer atop @weaveintel/live-agents.
 *
 * - Provides a `HandlerRegistry` so app boot can register named "handler
 *   kinds" once, then resolve them per-agent from `live_agent_handler_bindings`
 *   rows at runtime.
 * - Ships two built-in plugins: `agentic.react` and `deterministic.forward`.
 *   These cover most patterns (LLM ReAct loop, simple message router) and
 *   serve as the reference implementations for future kinds (Phase 6+).
 *
 * Geneweave is the canonical consumer (see
 * `apps/geneweave/src/live-agents/handler-registry-boot.ts`), but any app
 * that uses `@weaveintel/live-agents` can plug this package in.
 */

export {
  HandlerRegistry,
  createHandlerRegistry,
  type HandlerBinding,
  type HandlerAgentInfo,
  type HandlerContext,
  type HandlerKindFactory,
  type HandlerKindRegistration,
} from './handler-registry.js';

export { agenticReactHandler, type AgenticReactConfig } from './handlers/agentic-react.js';
export {
  deterministicForwardHandler,
  type DeterministicForwardConfig,
  type DeterministicForwardTarget,
  type DeterministicForwardContextExtras,
} from './handlers/deterministic-forward.js';
export {
  deterministicTemplateHandler,
  type DeterministicTemplateConfig,
} from './handlers/deterministic-template.js';
export {
  humanApprovalHandler,
  type HumanApprovalConfig,
  type HumanApprovalContextExtras,
  type ApprovalDb,
  type ApprovalRequestRowLike,
  type ApprovalIdGenerator,
} from './handlers/human-approval.js';

// Phase 4 — A2A handler kinds
export { a2aInboundHandler, type A2AInboundConfig } from './handlers/a2a-inbound.js';
export { a2aOutboundHandler, type A2AOutboundConfig } from './handlers/a2a-outbound.js';

// Phase 3 (mid-2026) — Expanded handler kind catalog
export { agenticComputerUseHandler, type AgenticComputerUseConfig } from './handlers/agentic-computer-use.js';
export { agenticBrowserHandler, type AgenticBrowserConfig } from './handlers/agentic-browser.js';
export { agenticCodeInterpreterHandler, type AgenticCodeInterpreterConfig } from './handlers/agentic-code-interpreter.js';
export { agenticVoiceRealtimeHandler, type AgenticVoiceRealtimeConfig } from './handlers/agentic-voice-realtime.js';
export { agenticMultimodalHandler, type AgenticMultimodalConfig } from './handlers/agentic-multimodal.js';
export { deterministicMapReduceHandler, type DeterministicMapReduceConfig } from './handlers/deterministic-mapreduce.js';
export { multiAgentSwarmHandler, type MultiAgentSwarmConfig } from './handlers/multi-agent-swarm.js';
export { externalMcpToolHandler, type ExternalMcpToolConfig } from './handlers/external-mcp-tool.js';

// Computer Use — weaveAgent bridge + tool registry
export {
  createCuaToolRegistry,
  type CuaToolRegistryOptions,
  wrapModelForCua,
  type WrapModelForCuaOptions,
  createCuaWeaveAgent,
  type CuaWeaveAgentConfig,
} from './computer-use/index.js';

// Phase 4 — In-process run cancellation bus
export { RunCancellationBus } from './run-cancellation.js';

// Phase 7 — Durable checkpoint store for live-agent tick continuity.
export {
  createDurableLiveAgentCheckpointStore,
  createInMemoryLiveAgentCheckpointStore,
  type LiveAgentCheckpointStore,
  type AgentCheckpointState,
} from './checkpoint-store.js';

// Phase 3 — Tool binder. Resolves an agent's tool surface from the DB.
export {
  resolveAgentToolCatalog,
  type AgentToolBindingDb,
  type AgentToolBindingRowLike,
  type ToolCatalogRowLike,
  type ResolvedAgentTools,
} from './tool-binder.js';

// Phase 3.5 — Model resolver. Reads model_capability_json /
// model_routing_policy_key / model_pinned_id from a live agent row.
export {
  resolveAgentModelSpec,
  type AgentModelFieldsRowLike,
  type AgentModelSource,
  type ResolvedAgentModelSpec,
} from './model-resolver.js';

// Phase 2 (live-agents capability parity) — DB-backed ModelResolver and
// per-agent overlay. Together these lift the per-tick routing pattern
// previously hand-written in geneweave's kaggle heartbeat into the
// reusable runtime layer.
export {
  weaveDbModelResolver,
  type WeaveDbModelResolverOptions,
  type ModelCandidate,
  type DbModelRoutingHints,
  type DbRoutingDecision,
} from './db-model-resolver.js';
export {
  weaveAgentOverlayResolver,
  type WeaveAgentOverlayResolverOptions,
  type ModelResolvedAuditEvent,
} from './agent-overlay-resolver.js';

// Phase 3 (live-agents capability parity) — DB-backed `LiveAgentPolicy`
// composer. Bundles geneweave's `DbToolPolicyResolver`, `DbToolApprovalGate`,
// `DbToolRateLimiter`, `DbToolAuditEmitter` into a single policy slot
// passed to `createHeartbeatSupervisor` (or any consumer of `HandlerContext`).
export {
  weaveDbLiveAgentPolicy,
  type WeaveDbLiveAgentPolicyOptions,
} from './db-policy.js';

// Phase 2 (DB-driven capability plan) — declarative `prepare()` recipes.
// Parse `live_agents.prepare_config_json` into a typed config and synthesise
// a `prepare()` function with the same shape a handler author would write
// by hand. See `db-prepare-resolver.ts` for the recipe schema.
export {
  parsePrepareConfig,
  dbPrepareFromConfig,
  type PrepareConfig,
  type PrepareSystemPromptRecipe,
  type PrepareUserGoalRecipe,
  type PrepareMemoryRecipe,
  type PrepareInbound,
  type PrepareInput,
  type PrepareOutput,
  type PrepareResolutionDeps,
  type PreparedRecipe,
} from './db-prepare-resolver.js';

// Phase 4 — Attention policy factory. Converts a live_attention_policies DB
// row into a live AttentionPolicy instance. Delegates to the shared policy
// constructors in @weaveintel/live-agents (heuristic, cron, model kinds).
export {
  resolveAttentionPolicy,
  resolveAttentionPolicyFromDb,
  type AttentionPolicyDb,
  type AttentionPolicyRowLike,
  type AttentionFactoryOptions,
} from './attention-factory.js';

import { HandlerRegistry, createHandlerRegistry } from './handler-registry.js';
import { agenticReactHandler } from './handlers/agentic-react.js';
import { deterministicForwardHandler } from './handlers/deterministic-forward.js';
import { deterministicTemplateHandler } from './handlers/deterministic-template.js';
import { humanApprovalHandler } from './handlers/human-approval.js';
import { a2aInboundHandler } from './handlers/a2a-inbound.js';
import { a2aOutboundHandler } from './handlers/a2a-outbound.js';
import { agenticComputerUseHandler } from './handlers/agentic-computer-use.js';
import { agenticBrowserHandler } from './handlers/agentic-browser.js';
import { agenticCodeInterpreterHandler } from './handlers/agentic-code-interpreter.js';
import { agenticVoiceRealtimeHandler } from './handlers/agentic-voice-realtime.js';
import { agenticMultimodalHandler } from './handlers/agentic-multimodal.js';
import { deterministicMapReduceHandler } from './handlers/deterministic-mapreduce.js';
import { multiAgentSwarmHandler } from './handlers/multi-agent-swarm.js';
import { externalMcpToolHandler } from './handlers/external-mcp-tool.js';

/**
 * Convenience: create a registry pre-populated with the built-in handler
 * kinds. Apps can add more after construction.
 *
 * Built-ins (Phase 4+):
 *   - agentic.react           — LLM ReAct loop over inbox
 *   - deterministic.forward   — pure router / fan-out
 *   - deterministic.template  — render DB fragment + emit
 *   - human.approval          — dual-control gate via tool_approval_requests
 *   - a2a.inbound             — A2A-aware ReAct loop (parses A2ATask from inbox)
 *   - a2a.outbound            — delegate to remote A2A agent via HTTP
 *
 * Phase 3 additions (mid-2026):
 *   - agentic.computer-use    — CUA screenshot→action loop (disabled by default)
 *   - agentic.browser         — Playwright browser automation (disabled by default)
 *   - agentic.code-interpreter — Python CSE sandbox execution
 *   - agentic.voice-realtime  — WebRTC real-time speech I/O
 *   - agentic.multimodal      — Vision-first ReAct loop
 *   - deterministic.mapreduce — Fan-out to N workers + reduce
 *   - multi-agent.swarm       — Peer-collaboration broadcast
 *   - external.mcp-tool       — MCP JSON-RPC tool invocation
 */
export function createDefaultHandlerRegistry(): HandlerRegistry {
  const reg = createHandlerRegistry();
  // Phase 4 originals
  reg.register(agenticReactHandler);
  reg.register(deterministicForwardHandler);
  reg.register(deterministicTemplateHandler);
  reg.register(humanApprovalHandler);
  reg.register(a2aInboundHandler);
  reg.register(a2aOutboundHandler);
  // Phase 3 additions (mid-2026)
  reg.register(agenticComputerUseHandler);
  reg.register(agenticBrowserHandler);
  reg.register(agenticCodeInterpreterHandler);
  reg.register(agenticVoiceRealtimeHandler);
  reg.register(agenticMultimodalHandler);
  reg.register(deterministicMapReduceHandler);
  reg.register(multiAgentSwarmHandler);
  reg.register(externalMcpToolHandler);
  return reg;
}

// Phase 5 — Generic mesh provisioner + supervisor + run-state bridge.
// Replaces bespoke per-domain `bootXxxMesh()` and `startXxxHeartbeat()`
// with mesh-agnostic equivalents driven entirely by DB blueprints.
export {
  provisionMesh,
  type ProvisionMeshDb,
  type ProvisionMeshOptions,
  type ProvisionMeshResult,
  type ProvisionAccountSpec,
  type IdGenerator,
  type MeshDefinitionRowLike,
  type AgentDefinitionRowLike,
  type MeshDelegationEdgeRowLike,
  type ToolCatalogRowLike as ProvisionToolCatalogRowLike,
  type LiveMeshRowLike,
  type LiveAgentRowLike,
  type LiveAgentHandlerBindingRowLike,
  type LiveAgentToolBindingRowLike,
} from './mesh-provisioner.js';

export {
  bridgeRunState,
  type RunBridgeDb,
  type BridgeRunStateOptions,
  type LiveRunRowLike,
  type LiveAgentRowLike as RunBridgeAgentRowLike,
  type LiveRunStepRowLike,
  type LiveRunEventRowLike,
} from './run-bridge.js';

export {
  createHeartbeatSupervisor,
  type HeartbeatSupervisorOptions,
  type HeartbeatSupervisorHandle,
  type SupervisorDb,
  type SupervisorAgentRowLike,
  type SupervisorMeshRowLike,
  type SupervisorHandlerBindingRowLike,
} from './heartbeat-supervisor.js';

// Phase 6 — One-call DB hydration entry points. These compose every
// Phase 1-5 primitive into a single user-facing constructor mirroring
// the `weave*` naming convention from `@weaveintel/live-agents`.
export {
  weaveLiveMeshFromDb,
  type WeaveLiveMeshFromDbOptions,
  type WeaveLiveMeshFromDbResult,
  type WeaveLiveMeshProvisionOptions,
} from './weave-live-mesh-from-db.js';
export {
  weaveLiveAgentFromDb,
  type WeaveLiveAgentFromDbOptions,
  type WeaveLiveAgentFromDbResult,
} from './weave-live-agent-from-db.js';
export type { LiveAgentsDb, SingleAgentReaderDb } from './db-types.js';
