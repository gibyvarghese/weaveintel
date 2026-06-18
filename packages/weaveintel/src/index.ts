// SPDX-License-Identifier: MIT
/**
 * @weaveintel/weaveintel — curated entry point (Phase 3).
 *
 * Most adopters need ~8 packages out of the ~78 the monorepo ships.
 * Importing them one-by-one is an onboarding cliff. This package re-exports
 * the surface that supports the golden path:
 *
 *     import { weaveRuntime, weaveAgent, defineTool } from '@weaveintel/weaveintel';
 *
 * The runtime constructor gives you ambient observability, hardened egress,
 * secret resolution, audit, and slots for guardrails/persistence/resilience.
 * Anything beyond this curated set lives in its specific package — there is
 * no hidden behavior in this meta-package, only re-exports.
 */

// Runtime + cross-cutting primitives
export {
  // Runtime
  weaveRuntime,
  type WeaveRuntime,
  type WeaveRuntimeOptions,
  type RuntimeEgressSlot,
  type RuntimePersistenceSlot,
  type RuntimeKvStore,
  type RuntimeResilienceSlot,
  type RuntimeGuardrailsSlot,
  RuntimeCapabilities,
  assertRuntimeRequires,
  describeRuntimeCapabilities,
  weaveAudit,
  weaveLogSafetyDowngrade,
  weaveInMemoryPersistence,
  // Execution context
  weaveContext,
  weaveChildContext,
  type ExecutionContext,
  // Hardened egress
  hardenedFetch,
  createHardenedFetch,
  // Secrets
  envSecretResolver,
  inMemorySecretResolver,
  chainSecretResolvers,
  requireSecret,
  // Tools
  weaveTool,
  weaveToolRegistry,
  type Tool,
  type ToolSchema,
  type ToolRegistry,
  // Observability primitives (interfaces; concrete tracers in @weaveintel/observability)
  type Tracer,
  type Span,
  weaveSetDefaultTracer,
  weaveGetDefaultTracer,
  weaveResolveTracer,
  // Event bus + events
  type EventBus,
  EventTypes,
  weaveEvent,
  // Security contracts
  type AuditLogger,
  type AuditEntry,
  type SecretResolver,
} from '@weaveintel/core';

// Agents
export { weaveAgent } from '@weaveintel/agents';

// Concrete observability adapters
export {
  weaveConsoleTracer,
  weaveInMemoryTracer,
} from '@weaveintel/observability';
