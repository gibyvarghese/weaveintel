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
  createHeartbeatSupervisor,
  type HeartbeatSupervisorHandle,
} from '@weaveintel/live-agents-runtime';
import type { Model } from '@weaveintel/core';
import type { DatabaseAdapter } from '../db.js';
import type { ProviderConfig } from '../chat.js';
import { getOrCreateModel } from '../chat-runtime.js';
import { getGenericLiveStore } from './generic-store.js';
import { getHandlerRegistry } from './handler-registry-boot.js';

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

  // Lazy model factory so we only build the LLM when an agentic.react
  // handler actually requests it. Failure → undefined → handlers fall
  // back to deterministic mode.
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

  const handle = await createHeartbeatSupervisor({
    db: opts.db,
    store,
    handlerRegistry: registry,
    modelFactory,
    resolveSystemPrompt,
    ...(opts.attentionPolicyKey ? { attentionPolicyKey: opts.attentionPolicyKey } : {}),
    logger: (msg) => console.log('[live-supervisor]', msg),
  });

  console.log('[live-supervisor] generic runtime enabled (LIVE_AGENTS_GENERIC_RUNTIME=1)');
  return handle;
}
