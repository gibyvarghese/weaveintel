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

/**
 * Convenience: create a registry pre-populated with the built-in handler
 * kinds. Apps can add more after construction.
 */
export function createDefaultHandlerRegistry(): HandlerRegistry {
  const reg = createHandlerRegistry();
  reg.register(agenticReactHandler);
  reg.register(deterministicForwardHandler);
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
