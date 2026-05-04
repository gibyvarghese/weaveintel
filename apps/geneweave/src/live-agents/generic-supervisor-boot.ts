/**
 * Phase 5 — Optional generic supervisor boot.
 *
 * Wires `createHeartbeatSupervisor()` from `@weaveintel/live-agents-runtime`
 * into the GeneWeave process. Off by default — enable via:
 *
 *   LIVE_AGENTS_GENERIC_RUNTIME=1
 *
 * The Kaggle heartbeat (`startKaggleHeartbeat()`) keeps running unchanged
 * for backward compatibility. The two heartbeats coexist safely because
 * their tick ids and worker ids never overlap (Kaggle uses prefix
 * `geneweave-kaggle-worker`, generic uses `geneweave-live-worker`).
 *
 * The generic supervisor:
 *   - Ticks every active mesh's active agents (regardless of domain).
 *   - Dispatches via the `HandlerRegistry` set up at boot in
 *     `handler-registry-boot.ts`.
 *   - Mirrors per-agent backlog/inbox progress into `live_run_steps` /
 *     `live_run_events` so the admin Live Runs view updates in real time.
 *
 * Operators can roll a new mesh out of the database (admin POST
 * `/api/admin/live-meshes/provision`) and watch ticks start within a few
 * seconds without touching code or restarting the process.
 */

import {
  weaveLiveMeshFromDb,
  weaveDbLiveAgentPolicy,
  weaveDbModelResolver,
  type HeartbeatSupervisorHandle,
} from '@weaveintel/live-agents-runtime';
import type { Model } from '@weaveintel/core';
import type { DatabaseAdapter } from '../db.js';
import type { ProviderConfig } from '../chat.js';
import { getOrCreateModel } from '../chat-runtime.js';
import { routeModel } from '../chat-routing-utils.js';
import { getGenericLiveStore } from './generic-store.js';
import { getHandlerRegistry } from './handler-registry-boot.js';
import { newUUIDv7 } from '../lib/uuid.js';
import { DbToolPolicyResolver, DbToolRateLimiter } from '../tool-policy-resolver.js';
import { DbToolAuditEmitter } from '../tool-audit-emitter.js';
import { DbToolApprovalGate } from '../tool-approval-gate.js';

export interface StartGenericSupervisorOptions {
  db: DatabaseAdapter;
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
  defaultModel: string;
  /** DB attention policy key. Optional — when omitted the engine's standard
   *  policy is used. */
  attentionPolicyKey?: string;
}

/**
 * Boot the generic supervisor when `LIVE_AGENTS_GENERIC_RUNTIME=1`. Returns
 * `null` (no-op) when the flag is absent or non-truthy. Failure inside the
 * supervisor itself is logged; this function never throws to the caller so
 * it can sit safely beside other boot tasks in `createGeneWeave()`.
 */
export async function startGenericSupervisorIfEnabled(
  opts: StartGenericSupervisorOptions,
): Promise<HeartbeatSupervisorHandle | null> {
  const flag = (process.env['LIVE_AGENTS_GENERIC_RUNTIME'] ?? '').toLowerCase();
  if (flag !== '1' && flag !== 'true' && flag !== 'yes') {
    return null;
  }

  const store = await getGenericLiveStore();
  const registry = getHandlerRegistry();

  // ─── Phase 2 (live-agents capability parity) ────────────────────────
  // Per-tick model selection runs through `weaveDbModelResolver` from
  // `@weaveintel/live-agents-runtime`. The runtime resolver owns the
  // listCandidates → routeModel → getModel pipeline and emits per-tick
  // routing context; we only inject geneweave's:
  //   • `listAvailableModelsForRouting`-equivalent (model_pricing rows
  //     filtered to configured providers, with the default included).
  //   • `routeModel(...)` — the live SmartModelRouter brain.
  //   • `getOrCreateModel(...)` — the singleton-aware model factory.
  // The runtime layer never sees a DB type — only the injected functions.
  const modelResolver = weaveDbModelResolver({
    listCandidates: async () => {
      const out: Array<{ id: string; provider: string }> = [];
      const seen = new Set<string>();
      const configured = new Set(Object.keys(opts.providers));
      try {
        const rows = await opts.db.listModelPricing();
        for (const row of rows) {
          if (!row.enabled || !configured.has(row.provider)) continue;
          const k = `${row.provider}:${row.model_id}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ id: row.model_id, provider: row.provider });
        }
      } catch {
        /* best-effort */
      }
      const defKey = `${opts.defaultProvider}:${opts.defaultModel}`;
      if (!seen.has(defKey) && configured.has(opts.defaultProvider)) {
        out.push({ id: opts.defaultModel, provider: opts.defaultProvider });
      }
      return out;
    },
    routeModel: async (cands, hints) => {
      const r = await routeModel(opts.db, cands, [], {
        taskType: hints.taskType ?? 'reasoning',
        prompt: hints.prompt ?? 'generic-supervisor-planner',
      });
      if (!r) return null;
      return {
        provider: r.provider,
        modelId: r.modelId,
        taskKey: r.taskKey,
        experimentName: r.experimentName,
      };
    },
    getOrCreateModel: async (provider, modelId) => {
      const cfg = opts.providers[provider];
      if (!cfg) throw new Error(`no provider config for ${provider}`);
      return getOrCreateModel(provider, modelId, cfg);
    },
    defaultTaskType: 'reasoning',
    log: (msg) => console.log('[generic-supervisor]', msg),
  });

  // Pinned fallback so handlers that read `ctx.model` (instead of
  // `ctx.modelResolver`) still work. Returns the configured default
  // model on best-effort basis; `undefined` puts handlers in
  // deterministic mode.
  const modelFactory = async (): Promise<Model | undefined> => {
    const cfg = opts.providers[opts.defaultProvider];
    if (!cfg) return undefined;
    try {
      return await getOrCreateModel(opts.defaultProvider, opts.defaultModel, cfg);
    } catch {
      return undefined;
    }
  };

  // DB-backed system-prompt resolver — looks up enabled prompts by key
  // (skill key / fragment key) so handlers stay grounded in the live
  // prompt registry rather than baking instructions into code.
  const resolveSystemPrompt = async (key: string): Promise<string | null> => {
    try {
      // Prefer prompt fragments (lightweight reusable blocks).
      const fragments = await opts.db.listPromptFragments();
      const f = fragments.find((row) => row.key === key && row.enabled === 1);
      if (f && typeof f.content === 'string' && f.content.length > 0) return f.content;
      // Fall back to a full prompt by name (legacy compatibility).
      const prompts = await opts.db.listPrompts();
      const p = prompts.find((row) => row.name === key);
      if (p && typeof p.template === 'string' && p.template.length > 0) return p.template;
    } catch {
      /* non-fatal — return null and let the handler use its config default */
    }
    return null;
  };

  // ─── Phase 7 (live-agents capability parity) ────────────────
  // Single-call mesh hydration via `weaveLiveMeshFromDb` — replaces the
  // direct `createHeartbeatSupervisor` call. Same primitives, one entry
  // point. The runtime package owns composition order; this app only
  // injects geneweave-specific resolvers/factories.
  const meshHandle = await weaveLiveMeshFromDb(opts.db, {
    store,
    handlerRegistry: registry,
    modelFactory,
    modelResolver,
    // ─── Phase 3 (live-agents capability parity) ────────────────
    // First-class per-tick policy bundle. Mirrors the DB-backed
    // primitives already wired into ChatEngine.toolOptions so every
    // live-agent tool call (via `agentic.react`) is gated by the same
    // resolver/approval/rate-limit/audit pipeline operators administer
    // through the admin tabs. Adapter instances are stateless w.r.t.
    // each other (each holds only the DB ref), so reusing them across
    // chat + live-agents is safe.
    policy: weaveDbLiveAgentPolicy({
      policyResolver: new DbToolPolicyResolver(opts.db),
      approvalGate: new DbToolApprovalGate(opts.db),
      rateLimiter: new DbToolRateLimiter(opts.db),
      auditEmitter: new DbToolAuditEmitter(opts.db),
    }),
    resolveSystemPrompt,
    // Inject per-tick context extras for handlers that need DB access:
    //   - human.approval needs `approvalDb` + `newApprovalId`.
    //   - deterministic.* needs `resolveAgentByRole` (looks up the live
    //     agent uuid for a role inside the same mesh).
    extraContextFor: async (_binding, agent) => ({
      approvalDb: opts.db,
      newApprovalId: () => newUUIDv7(),
      resolveAgentByRole: async (roleKey: string) => {
        const peers = await opts.db.listLiveAgents({
          meshId: agent.meshId,
          status: 'ACTIVE',
        });
        const found = peers.find((p) => p.role_key === roleKey);
        return found ? found.id : null;
      },
    }),
    ...(opts.attentionPolicyKey ? { attentionPolicyKey: opts.attentionPolicyKey } : {}),
    logger: (msg) => console.log('[live-supervisor]', msg),
  });

  console.log('[live-supervisor] generic runtime enabled (LIVE_AGENTS_GENERIC_RUNTIME=1)');
  return meshHandle.supervisor;
}
