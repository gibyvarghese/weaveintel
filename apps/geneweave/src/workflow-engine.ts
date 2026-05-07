/**
 * @weaveintel/geneweave — Workflow Platform Phase 1 wiring
 *
 * Composes the package-level Phase 1 primitives from
 * `@weaveintel/workflows` (HandlerResolverRegistry, default resolvers,
 * WorkflowDefinitionStore, DefaultWorkflowEngine) into a runtime that:
 *
 *   1. Hydrates `workflow_defs` rows on demand via DbWorkflowDefinitionStore.
 *   2. Resolves handler refs (`tool:foo`, `script:`, `noop`, …) at run time
 *      using a registry seeded with the seven built-in resolvers.
 *   3. Syncs the registry back to the `workflow_handler_kinds` catalog so
 *      admin UIs can render handler-kind pickers without hardcoded enums.
 *
 * The engine is constructed once at startup and reused across admin
 * route handlers and other geneweave subsystems that need to start
 * workflow runs from DB definitions.
 */

import { randomUUID } from 'node:crypto';
import {
  DefaultWorkflowEngine,
  HandlerResolverRegistry,
  InMemoryCostMeter,
  InMemoryWorkflowDefinitionStore,
  createNoopResolver,
  createScriptResolver,
  createToolResolver,
  describeHandlerKinds,
  type CostMeter,
  type HandlerKindDescriptor,
  type WorkflowDefinitionStore,
  type WorkflowRunRepository,
  type CheckpointStore,
} from '@weaveintel/workflows';
import type { WorkflowDefinition, WorkflowStep } from '@weaveintel/core';
import type { DatabaseAdapter } from './db.js';
import { DbWorkflowRunRepository } from './workflows/db-workflow-run-repository.js';
import { DbCheckpointStore } from './workflows/db-checkpoint-store.js';

/**
 * DB-backed `WorkflowDefinitionStore` adapter.
 *
 * Marshals `workflow_defs` rows to/from `Workflow` shapes used by the
 * package-level engine. Keeps the package fully DB-agnostic: the
 * adapter lives in geneweave; the package only sees the interface.
 */
class DbWorkflowDefinitionStore implements WorkflowDefinitionStore {
  constructor(private readonly db: DatabaseAdapter) {}

  async list(): Promise<WorkflowDefinition[]> {
    const rows = await this.db.listWorkflowDefs();
    return rows.filter(r => r.enabled !== 0).map(rowToWorkflow);
  }

  async get(idOrKey: string): Promise<WorkflowDefinition | null> {
    const row = await this.db.getWorkflowDef(idOrKey);
    if (!row) return null;
    return rowToWorkflow(row);
  }

  async save(def: WorkflowDefinition): Promise<WorkflowDefinition> {
    const existing = await this.db.getWorkflowDef(def.id);
    const stepsJson = JSON.stringify(def.steps ?? []);
    // Pack `outputContract` into metadata under a reserved key so the
    // existing `workflow_defs.metadata` JSON column carries it without
    // requiring a schema migration. `rowToWorkflow` unpacks it on read.
    const mergedMetadata: Record<string, unknown> | undefined = (def.metadata || def.outputContract)
      ? { ...(def.metadata ?? {}), ...(def.outputContract ? { __outputContract: def.outputContract } : {}) }
      : undefined;
    const metadataJson = mergedMetadata ? JSON.stringify(mergedMetadata) : null;
    if (existing) {
      await this.db.updateWorkflowDef(def.id, {
        name: def.name,
        description: def.description ?? null,
        version: def.version ?? '1.0',
        steps: stepsJson,
        entry_step_id: def.entryStepId,
        metadata: metadataJson,
      });
    } else {
      await this.db.createWorkflowDef({
        id: def.id,
        name: def.name,
        description: def.description ?? null,
        version: def.version ?? '1.0',
        steps: stepsJson,
        entry_step_id: def.entryStepId,
        metadata: metadataJson,
        enabled: 1,
      });
    }
    return def;
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteWorkflowDef(id);
  }
}

function rowToWorkflow(row: {
  id: string;
  name: string;
  description: string | null;
  version: string;
  steps: string;
  entry_step_id: string;
  metadata: string | null;
}): WorkflowDefinition {
  let steps: WorkflowStep[] = [];
  try { steps = JSON.parse(row.steps) as WorkflowStep[]; } catch { /* leave empty */ }
  let metadata: Record<string, unknown> | undefined;
  let outputContract: WorkflowDefinition['outputContract'] | undefined;
  if (row.metadata) {
    try {
      const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
      if (parsed['__outputContract']) {
        outputContract = parsed['__outputContract'] as WorkflowDefinition['outputContract'];
        const { __outputContract: _drop, ...rest } = parsed;
        void _drop;
        if (Object.keys(rest).length > 0) metadata = rest;
      } else {
        metadata = parsed;
      }
    } catch { /* ignore */ }
  }
  return {
    id: row.id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    version: row.version,
    steps,
    entryStepId: row.entry_step_id,
    ...(metadata ? { metadata } : {}),
    ...(outputContract ? { outputContract } : {}),
  };
}

/**
 * Build the geneweave-wide `HandlerResolverRegistry` for Phase 1.
 *
 * Seeds the registry with the seven built-in resolvers from
 * `@weaveintel/workflows` (noop, script, tool, prompt, agent, mcp,
 * subworkflow). The `tool:` resolver is wired against the in-process
 * BUILTIN_TOOLS map; later phases will swap this for a registry-backed
 * resolver that respects per-tenant tool catalog filtering.
 *
 * The remaining resolver kinds (prompt/agent/mcp/subworkflow) are
 * intentionally **not** wired in Phase 1 — they require runtime hooks
 * (model client, agent registry, MCP gateway, sub-engine) that are
 * better wired in Phase 2 once the catalog UI exists.
 */
export function buildWorkflowResolverRegistry(opts: {
  // Optional injection point for the tool resolver. If omitted, the
  // resolver is omitted entirely and steps that reference `tool:foo`
  // will fail at execution time with a clear error.
  //
  // The getter returns a tool-like object that exposes either a callable
  // (`(input) => result`) or an `execute(input)` method. Geneweave's
  // BUILTIN_TOOLS records expose the latter; the adapter below normalizes
  // both shapes into the `(input) => Promise<result>` contract that
  // `@weaveintel/workflows`'s `createToolResolver` expects.
  toolGetter?: (key: string) => unknown;
}): HandlerResolverRegistry {
  const reg = new HandlerResolverRegistry();
  reg.register(createNoopResolver());
  reg.register(createScriptResolver());
  if (opts.toolGetter) {
    const getter = opts.toolGetter;
    reg.register(
      createToolResolver({
        async getTool(toolKey: string) {
          const tool = getter(toolKey);
          if (!tool) return undefined;
          if (typeof tool === 'function') {
            return tool as (input: Record<string, unknown>) => Promise<unknown>;
          }
          if (typeof tool === 'object' && tool !== null) {
            // weaveTool() / defineTool() shape: { schema, invoke(ctx, { arguments }) }
            // The workflow engine has no per-call ToolContext, so we pass an
            // empty stub. Tools that need chat/user/agent context must be
            // wrapped explicitly by Phase 2 catalog wiring.
            if ('invoke' in tool && typeof (tool as { invoke: unknown }).invoke === 'function') {
              const invoke = (tool as { invoke: (ctx: Record<string, unknown>, input: { arguments: Record<string, unknown> }) => Promise<unknown> }).invoke.bind(tool);
              return async (variables: Record<string, unknown>) => invoke({}, { arguments: variables });
            }
            // Alternate shape: { execute(args) }
            if ('execute' in tool && typeof (tool as { execute: unknown }).execute === 'function') {
              return (tool as { execute: (input: Record<string, unknown>) => Promise<unknown> }).execute.bind(tool);
            }
          }
          return undefined;
        },
      }),
    );
  }
  return reg;
}

/**
 * Sync the in-process resolver registry into the
 * `workflow_handler_kinds` catalog table. Called once at startup.
 *
 * Behavior:
 *   - INSERT new kinds with `enabled=1, source='builtin'`.
 *   - UPDATE description/config_schema/source on existing rows.
 *   - Preserve operator-edited `enabled` flag (handled by the DB upsert).
 *
 * Best-effort: failures are logged and do not block startup.
 */
export async function syncWorkflowHandlerKindsToDb(
  db: DatabaseAdapter,
  registry: HandlerResolverRegistry,
): Promise<void> {
  const kinds: HandlerKindDescriptor[] = describeHandlerKinds(registry);
  for (const k of kinds) {
    try {
      const existing = await db.getWorkflowHandlerKind(k.kind);
      await db.upsertWorkflowHandlerKind({
        id: existing?.id ?? randomUUID(),
        kind: k.kind,
        description: k.description ?? null,
        config_schema: k.configSchema ? JSON.stringify(k.configSchema) : null,
        enabled: existing ? existing.enabled : 1,
        source: 'builtin',
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[workflow-handler-kinds] failed to sync kind '${k.kind}':`, err);
    }
  }
}

export interface WorkflowEngineHandle {
  engine: DefaultWorkflowEngine;
  registry: HandlerResolverRegistry;
  store: WorkflowDefinitionStore;
  /** Phase 5: in-memory cost meter (per-process). */
  costMeter: CostMeter;
  /** Phase 5: DB-backed run repository. */
  runRepository: WorkflowRunRepository;
  /** Phase 5: DB-backed checkpoint store. */
  checkpointStore: CheckpointStore;
}

/**
 * Construct the geneweave singleton workflow engine.
 *
 * Caller wires this once at startup (in `index.ts` after
 * `seedDefaultData`) and passes the resulting handle to admin routes
 * that need to start runs from DB definitions.
 */
export function createGeneweaveWorkflowEngine(opts: {
  db: DatabaseAdapter;
  toolGetter?: (key: string) => unknown;
  contractEmitter?: import('@weaveintel/workflows').ContractEmitter;
}): WorkflowEngineHandle {
  const registry = buildWorkflowResolverRegistry({
    ...(opts.toolGetter ? { toolGetter: opts.toolGetter } : {}),
  });
  const store = new DbWorkflowDefinitionStore(opts.db);
  // We also wire an in-memory cache layer as the primary store: the
  // engine's built-in cache plus the DB fallback gives us the right
  // mix of speed and correctness for hot definitions.
  const memCache = new InMemoryWorkflowDefinitionStore();
  const layered: WorkflowDefinitionStore = {
    list: () => store.list(),
    async get(idOrKey: string) {
      const cached = await memCache.get(idOrKey);
      if (cached) return cached;
      const fromDb = await store.get(idOrKey);
      if (fromDb) await memCache.save(fromDb);
      return fromDb;
    },
    async save(def: WorkflowDefinition) {
      await store.save(def);
      await memCache.save(def);
      return def;
    },
    async delete(id: string) {
      await store.delete(id);
      await memCache.delete(id);
    },
  };
  const costMeter = new InMemoryCostMeter();
  const runRepository = new DbWorkflowRunRepository(opts.db);
  const checkpointStore = new DbCheckpointStore(opts.db);
  const engine = new DefaultWorkflowEngine({
    resolverRegistry: registry,
    definitionStore: layered,
    runRepository,
    checkpointStore,
    costMeter,
    ...(opts.contractEmitter ? { contractEmitter: opts.contractEmitter } : {}),
  });
  return { engine, registry, store: layered, costMeter, runRepository, checkpointStore };
}

export { DbWorkflowDefinitionStore };
