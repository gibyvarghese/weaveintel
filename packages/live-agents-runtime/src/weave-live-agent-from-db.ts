/**
 * Phase 6 — `weaveLiveAgentFromDb`: single-agent hydration.
 *
 * Loads ONE agent's enabled handler binding from the DB and returns a
 * ready-to-invoke `TaskHandler` plus its `HandlerContext`. The supervisor
 * loop is NOT started — this is the building block for ad-hoc invocation,
 * tests, admin "run-once" buttons, and adding a single agent to an
 * already-running supervisor's mesh.
 *
 * For the full mesh + heartbeat pattern, use `weaveLiveMeshFromDb`.
 *
 * --- Adoption guidance ---
 *
 *   - Tests: hydrate one agent, drive it manually with a fake action and
 *     execution context. No StateStore / heartbeat overhead.
 *   - Admin "Run Once": fetch the handler, invoke it against a synthetic
 *     prompt, return the result inline.
 *   - Custom orchestrators: hydrate the agent then dispatch ticks via
 *     the orchestrator's own scheduler instead of `createHeartbeat`.
 */

import type { Model } from '@weaveintel/core';
import type { StateStore, TaskHandler } from '@weaveintel/live-agents';
import type { LiveAgentPolicy, ModelResolver } from '@weaveintel/live-agents';

import {
  HandlerRegistry,
  type HandlerBinding,
  type HandlerContext,
  type HandlerAgentInfo,
  type HandlerKindRegistration,
} from './handler-registry.js';
import { createDefaultHandlerRegistry } from './index.js';
import type { SingleAgentReaderDb } from './db-types.js';

export interface WeaveLiveAgentFromDbOptions {
  /** Optional StateStore. Required only if the handler kind reads from
   *  `ctx.store`-like helpers (none of the four built-ins do today, but
   *  custom kinds may). Reserved for forward compatibility. */
  store?: StateStore;

  // ── Capability slots (mirror weaveLiveAgent) ──
  modelResolver?: ModelResolver;
  /** Pinned model. Required for `agentic.react` when no resolver is set. */
  model?: Model;
  policy?: LiveAgentPolicy;

  // ── Handler kinds ──
  /** Extra handler kinds beyond the four built-ins. */
  extraHandlerKinds?: HandlerKindRegistration[];
  /** Pre-built registry. When supplied, `extraHandlerKinds` is ignored. */
  handlerRegistry?: HandlerRegistry;

  // ── Per-tick context extras (forwarded to the handler) ──
  resolveSystemPrompt?: (key: string) => Promise<string | null>;
  /** Free-form context fields the handler kind expects. Spread into the
   *  built `HandlerContext` (e.g. `approvalDb`, `resolveAgentByRole`). */
  extraContext?: Record<string, unknown>;

  /** Logger. */
  logger?: (msg: string) => void;
}

export interface WeaveLiveAgentFromDbResult {
  /** Resolved agent metadata from the DB row. */
  agent: HandlerAgentInfo;
  /** The enabled handler binding picked for this agent. */
  binding: HandlerBinding;
  /** The fully-built per-tick context the handler will see. */
  context: HandlerContext;
  /** Ready-to-invoke task handler. Apps can call it with their own
   *  `Action` + `ActionExecutionContext`. */
  handler: TaskHandler;
}

/**
 * Hydrate a single agent into a ready-to-invoke handler.
 *
 * @example
 * ```ts
 * const { handler, context } = await weaveLiveAgentFromDb(db, agentId, {
 *   model: gpt4o,
 *   resolveSystemPrompt,
 * });
 * const result = await handler(action, execCtx, weaveContext({}));
 * ```
 *
 * Throws when:
 *   - The agent id is unknown.
 *   - The agent has no enabled handler binding.
 *   - The binding's `handler_kind` is not registered.
 */
export async function weaveLiveAgentFromDb(
  db: SingleAgentReaderDb,
  agentId: string,
  opts: WeaveLiveAgentFromDbOptions = {},
): Promise<WeaveLiveAgentFromDbResult> {
  const log =
    opts.logger ?? ((m: string) => console.log('[live-agent-from-db]', m));

  // 1. Load the agent row. Use the broad `listLiveAgents` to find it
  //    rather than a getter so the SingleAgentReaderDb interface stays
  //    minimal (only one method needed).
  const allAgents = await db.listLiveAgents({});
  const row = allAgents.find((a) => a.id === agentId);
  if (!row) {
    throw new Error(`weaveLiveAgentFromDb: agent ${agentId} not found`);
  }

  // 2. Load the most recently updated enabled handler binding.
  const bindings = await db.listLiveAgentHandlerBindings({
    agentId,
    enabledOnly: true,
  });
  if (bindings.length === 0) {
    throw new Error(
      `weaveLiveAgentFromDb: agent ${agentId} has no enabled handler binding`,
    );
  }
  const bindingRow = bindings[0]!;
  let config: Record<string, unknown> = {};
  if (bindingRow.config_json) {
    try {
      const parsed = JSON.parse(bindingRow.config_json);
      if (parsed && typeof parsed === 'object') {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      log(
        `binding ${bindingRow.id} has invalid config_json — using empty config`,
      );
    }
  }

  // 3. Build the handler-info + binding records the registry expects.
  const agent: HandlerAgentInfo = {
    id: row.id,
    meshId: row.mesh_id,
    roleKey: row.role_key,
    name: row.name,
  };
  const binding: HandlerBinding = {
    id: bindingRow.id,
    agentId,
    handlerKind: bindingRow.handler_kind,
    config,
  };

  // 4. Resolve the registry. Caller-supplied wins; otherwise default + extras.
  const registry = opts.handlerRegistry ?? createDefaultHandlerRegistry();
  if (!opts.handlerRegistry && opts.extraHandlerKinds) {
    for (const reg of opts.extraHandlerKinds) {
      registry.register(reg);
    }
  }

  // 5. Build the per-tick HandlerContext. Conditional spreads keep
  //    exactOptionalPropertyTypes-safe.
  const context: HandlerContext = {
    binding,
    agent,
    log: (m) => log(`[${agent.roleKey}/${agent.id.slice(0, 8)}] ${m}`),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.modelResolver ? { modelResolver: opts.modelResolver } : {}),
    ...(opts.policy ? { policy: opts.policy } : {}),
    ...(opts.resolveSystemPrompt
      ? { resolveSystemPrompt: opts.resolveSystemPrompt }
      : {}),
    ...(opts.extraContext ?? {}),
  };

  // 6. Build the handler.
  const handler = registry.build(context);

  return { agent, binding, context, handler };
}
