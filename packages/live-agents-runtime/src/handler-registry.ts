/**
 * Generic handler-kind registry for the DB-driven live-agents runtime.
 *
 * --- Why this exists ---
 *
 * The live-agents engine in `@weaveintel/live-agents` dispatches per-tick work
 * to a `TaskHandler` keyed by agent role string. Historically each domain
 * (Kaggle, inbox triage, …) wrote one bespoke `TaskHandler` per role and
 * passed them as a `Record<roleKey, TaskHandler>` map at boot.
 *
 * Phase 2 of the DB-driven runtime plan replaces that hardcoded map with a
 * registry of **handler kinds**. A handler kind is a small, named, generic
 * recipe for what an agent does on each tick (`agentic.react`,
 * `deterministic.forward`, `human.approval`, …). Operators bind one of these
 * kinds to each agent via the `live_agent_handler_bindings` table, with
 * arbitrary `config_json` to tune behaviour (system prompt key, max steps,
 * outbound subject, etc.).
 *
 * The runtime walks the bindings, resolves each one to a `TaskHandler` via
 * `HandlerRegistry.resolve(...)`, and hands them to the live-agents engine's
 * existing `taskHandlers` map keyed by `agentId.toLowerCase()` (the engine
 * already does the lower-case lookup).
 *
 * --- Boundary ---
 *
 * - Pure runtime contracts. **No DB types** in this package.
 * - Geneweave passes a fully-resolved `HandlerContext` per agent (model,
 *   tools, system-prompt resolver). This package never reads SQLite.
 * - Handler kinds are **registered programmatically** at app boot, but
 *   activation per agent is **DB-driven** (one `live_agent_handler_bindings`
 *   row per active agent).
 */

import type { Model, ToolRegistry } from '@weaveintel/core';
import type {
  LiveAgentPolicy,
  ModelResolver,
  TaskHandler,
} from '@weaveintel/live-agents';
import type { PrepareConfig, PrepareResolutionDeps } from './db-prepare-resolver.js';

/**
 * The DB row data needed to construct a handler instance for a single agent.
 * Geneweave maps `live_agent_handler_bindings` rows into this shape.
 */
export interface HandlerBinding {
  /** Stable id of the binding row (for logs/audit). */
  id: string;
  /** Agent this binding is for. */
  agentId: string;
  /** Handler-kind key (e.g. `'agentic.react'`). Must match a registered kind. */
  handlerKind: string;
  /** Operator-supplied tunables. Validated by the handler factory. */
  config: Record<string, unknown>;
}

/** Metadata carried into the factory describing the agent the handler is for. */
export interface HandlerAgentInfo {
  /** Stable agent id. */
  id: string;
  /** Mesh this agent belongs to. */
  meshId: string;
  /** Role key (`'discoverer'`, `'triager'`, etc.). Used by the live-agents
   *  engine to look up the right `TaskHandler`. */
  roleKey: string;
  /** Display name for logs / agent.run() name field. */
  name: string;
}

/**
 * Per-agent execution context handed to the handler factory at resolve time.
 *
 * Geneweave is responsible for populating these slots from the DB / runtime:
 *   - `model`: resolved via routing, only required for agentic kinds.
 *   - `tools`: resolved via `live_agent_tool_bindings` (Phase 3).
 *   - `resolveSystemPrompt(key)`: looks up the prompt text behind a skill /
 *      prompt-fragment key. Used by `agentic.react` to keep prompts DB-driven.
 *   - `log`: human-friendly tagged logger.
 */
export interface HandlerContext {
  binding: HandlerBinding;
  agent: HandlerAgentInfo;
  log: (msg: string) => void;
  /** Required only for handler kinds that perform LLM calls. */
  model?: Model;
  /**
   * Phase 1 (live-agents capability parity) — first-class per-tick model
   * resolver. Preferred over `model` when both are set; `model` is the
   * fallback when the resolver returns `undefined` or throws. Either
   * `model` OR `modelResolver` MUST be present for LLM-driven kinds
   * (e.g. `agentic.react`).
   */
  modelResolver?: ModelResolver;
  /** Optional resolved tool registry for the agent. */
  tools?: ToolRegistry;
  /**
   * Phase 3 (live-agents capability parity) — first-class per-tick policy
   * bundle. When supplied, LLM-driven handler kinds (`agentic.react`) wrap
   * the per-tick `tools` registry with policy enforcement before calling
   * the ReAct loop. Build with `weaveLiveAgentPolicy({ ... })` from
   * `@weaveintel/live-agents`, or `weaveDbLiveAgentPolicy({ ... })` from
   * this package for DB-backed enforcement.
   */
  policy?: LiveAgentPolicy;
  /** Resolve a DB-stored prompt body by key (skill key / fragment key). */
  resolveSystemPrompt?: (key: string) => Promise<string | null>;
  /**
   * Phase 2 (DB-driven capability plan) — declarative `prepare()` recipe
   * loaded from `live_agents.prepare_config_json`. When present, LLM
   * handler kinds (`agentic.react`) build their `prepare()` from this
   * recipe instead of the inline config defaults. See
   * {@link ./db-prepare-resolver.ts} for the recipe schema.
   */
  prepareConfig?: PrepareConfig;
  /**
   * Phase 2 — dependencies the recipe runtime needs (prompt-text resolver,
   * default system prompt). Apps inject these once at supervisor build
   * time. Required when any `prepareConfig.systemPrompt.promptKey` is set.
   */
  prepareDeps?: PrepareResolutionDeps;
}

/** Factory signature: pure function from `HandlerContext` to `TaskHandler`. */
export type HandlerKindFactory = (ctx: HandlerContext) => TaskHandler;

/**
 * A registration record. Description + (optional) JSON-schema-ish hint are
 * surfaced to operators in the admin UI so they know what `config_json`
 * fields are valid for each kind.
 */
export interface HandlerKindRegistration {
  kind: string;
  description: string;
  /** JSON Schema (loose) describing the expected `config_json` shape. Hint
   *  only — handlers may also accept extra fields. */
  configSchema?: Record<string, unknown>;
  factory: HandlerKindFactory;
}

/** In-memory registry. One per process is sufficient. */
export class HandlerRegistry {
  private readonly map = new Map<string, HandlerKindRegistration>();

  /** Register a handler kind. Throws if `kind` is already registered (caught
   *  early so an app boot doesn't silently shadow a built-in plugin). */
  register(reg: HandlerKindRegistration): void {
    if (this.map.has(reg.kind)) {
      throw new Error(`HandlerRegistry: kind "${reg.kind}" already registered`);
    }
    this.map.set(reg.kind, reg);
  }

  /** Look up a registration. Returns `null` if no kind matches. */
  resolve(kind: string): HandlerKindRegistration | null {
    return this.map.get(kind) ?? null;
  }

  /** Build the underlying `TaskHandler` for a binding + context, or throw a
   *  descriptive error if the kind is unknown. */
  build(ctx: HandlerContext): TaskHandler {
    const reg = this.resolve(ctx.binding.handlerKind);
    if (!reg) {
      throw new Error(
        `HandlerRegistry: unknown handler kind "${ctx.binding.handlerKind}" ` +
          `for agent ${ctx.agent.id} (binding ${ctx.binding.id}). ` +
          `Known kinds: ${this.kinds().join(', ') || '(none)'}`,
      );
    }
    return reg.factory(ctx);
  }

  /** List all registered kinds (for the admin UI dropdown). */
  list(): HandlerKindRegistration[] {
    return [...this.map.values()];
  }

  /** List just the kind keys. */
  kinds(): string[] {
    return [...this.map.keys()];
  }
}

/** Convenience factory. */
export function createHandlerRegistry(): HandlerRegistry {
  return new HandlerRegistry();
}
