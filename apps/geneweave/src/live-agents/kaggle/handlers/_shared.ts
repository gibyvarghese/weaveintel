/**
 * Shared utilities used by every Kaggle role handler.
 *
 * Pulled out of the original monolithic `role-handlers.ts` so each role file
 * stays focused on its own logic. No business decisions live here — only
 * pure helpers (id parsing, slug normalization, kernel polling, inbound
 * loading, message dispatch).
 */

import type {
  ActionExecutionContext,
  ModelResolver,
  TaskHandler,
} from '@weaveintel/live-agents';
import {
  type KaggleAdapter,
  type KaggleCredentials,
} from '@weaveintel/tools-kaggle';
import type { Model } from '@weaveintel/core';
import type { KaggleAgentRole } from '../account-bindings.js';
import type {
  KagglePlaybook,
  KagglePlaybookResolver,
} from '../playbook-resolver.js';
import type { DatabaseAdapter } from '../../../db.js';

export const DEFAULT_MAX_ITERATIONS = 8;

export interface KaggleRoleHandlersOptions {
  /** Override the kaggle adapter (defaults to the live REST adapter). */
  adapter?: KaggleAdapter;
  /** Override credential resolution (defaults to KAGGLE_USERNAME/KAGGLE_KEY env). */
  credentials?: KaggleCredentials;
  /** Optional console.log replacement. */
  log?: (msg: string) => void;
  /** LLM used by the strategist to plan each iteration. If absent, deterministic mode is used. */
  plannerModel?: Model;
  /**
   * Phase 5 (live-agents capability parity) — first-class per-tick model
   * resolver. The strategist rebuilds its inner ReAct handler on every tick
   * with whatever model the resolver picks (typically backed by
   * `weaveDbModelResolver` from `@weaveintel/live-agents-runtime`). Falls
   * back to `plannerModel` when the resolver returns `undefined` or throws.
   *
   * The Phase 1 alias `resolveModelForRole?: (role, hint) => Promise<Model>`
   * was removed in Phase 5 — pass a `ModelResolver` directly. To wrap an
   * existing per-role callback, lift it via `weaveModelResolverFromFn(...)`.
   */
  modelResolver?: ModelResolver;
  /**
   * Default iteration cap when no playbook matches (deterministic mode only).
   * The matched playbook's `examples.maxIterations` overrides this when present.
   */
  maxIterations?: number;
  /** DB-backed playbook resolver. REQUIRED for production. */
  playbookResolver?: KagglePlaybookResolver;
  /** DB adapter for Phase K7d submission-validation persistence. */
  db?: DatabaseAdapter;
  /** Tenant id for rubric scoping (Phase K7d). Defaults to null (global). */
  tenantId?: string | null;
}

export interface OperationalDefaults {
  topNAgentic: number;
  topNDeterministic: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

/** Map of role label → TaskHandler. Keys MUST match the role labels used by
 *  the mesh template (`mesh-template.ts`). */
export type KaggleHandlerMap = Record<string, TaskHandler>;

/** Bundle of shared per-tick resources passed into every per-role factory. */
export interface SharedHandlerContext {
  opts: KaggleRoleHandlersOptions;
  adapter: KaggleAdapter;
  log: (m: string) => void;
  /** Lazy-resolved catch-all playbook defaults (top-N, poll cadence). */
  getOpDefaults: () => Promise<OperationalDefaults>;
}

export const noopHandler: TaskHandler = async () => ({
  completed: true,
  summaryProse: 'no-op',
});

/** Kaggle's pushKernel returns a ref like '/code/<owner>/<slug>' but its
 * status/output endpoints expect '<owner>/<slug>'. Normalize. */
export function normalizeKernelRef(rawRef: string, kernelUrl: string): string {
  if (rawRef && !rawRef.startsWith('/')) return rawRef;
  const url = kernelUrl || rawRef;
  const m = url.match(/(?:code|kernels)\/([^/]+)\/([^/?#]+)/);
  if (m && m[1] && m[2]) return `${m[1]}/${m[2]}`;
  return rawRef;
}

export async function pollKernelUntilTerminal(
  adapter: KaggleAdapter,
  creds: KaggleCredentials,
  kernelRef: string,
  log: (m: string) => void,
  pollIntervalMs: number,
  pollTimeoutMs: number,
): Promise<{ status: string; failureMessage: string | null; logExcerpt: string; outputFiles: string[] }> {
  const terminal = new Set(['complete', 'error', 'cancelled', 'cancelAcknowledged']);
  const maxAttempts = Math.max(1, Math.ceil(pollTimeoutMs / pollIntervalMs));
  let status = 'unknown';
  let failureMessage: string | null = null;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const st = await adapter.getKernelStatus(creds, kernelRef);
      status = st.status;
      failureMessage = st.failureMessage;
      log(`poll[${i}] ref=${kernelRef} status=${status}`);
      if (terminal.has(status)) break;
    } catch (err) {
      log(`poll[${i}] error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  let logExcerpt = '';
  let outputFiles: string[] = [];
  try {
    const out = await adapter.getKernelOutput(creds, kernelRef);
    outputFiles = out.files.map((f) => f.fileName);
    if (out.log) logExcerpt = out.log.slice(-2000);
  } catch (err) {
    log(`output fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { status, failureMessage, logExcerpt, outputFiles };
}

export function resolveCreds(opts: KaggleRoleHandlersOptions): KaggleCredentials {
  if (opts.credentials) return opts.credentials;
  const username = process.env['KAGGLE_USERNAME'];
  const key = process.env['KAGGLE_KEY'];
  if (!username || !key) {
    throw new Error(
      'Kaggle credentials missing: set KAGGLE_USERNAME and KAGGLE_KEY in env or pass credentials to createKaggleRoleHandlers.',
    );
  }
  return { username, key };
}

function nextAgentId(currentAgentId: string, nextRole: KaggleAgentRole): string {
  // Agent ids are `${meshId}::${role}` per mesh-template.ts
  const idx = currentAgentId.lastIndexOf('::');
  if (idx < 0) throw new Error(`Unexpected agent id shape: ${currentAgentId}`);
  return `${currentAgentId.slice(0, idx)}::${nextRole}`;
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Normalize whatever the Discoverer/Strategist embedded as competitionId
 * (slug, ref, or full Kaggle URL) into the slug Kaggle's API expects. */
export function competitionSlugFrom(value: string): string {
  if (!value) return '';
  const m = value.match(/competitions\/([^/?#]+)/);
  if (m && m[1]) return m[1];
  return value.replace(/^\/+|\/+$/g, '');
}

export async function emitToNextAgent(
  context: ActionExecutionContext,
  nextRole: KaggleAgentRole,
  subject: string,
  body: string,
  topic: string,
): Promise<{ messageId: string; backlogId: string; nextAgentId: string }> {
  const toId = nextAgentId(context.agent.id, nextRole);
  const messageId = makeId('msg');
  const backlogId = makeId('backlog');
  const nowIso = context.nowIso;

  await context.stateStore.saveMessage({
    id: messageId,
    meshId: context.agent.meshId,
    fromType: 'AGENT',
    fromId: context.agent.id,
    fromMeshId: context.agent.meshId,
    toType: 'AGENT',
    toId,
    topic,
    kind: 'TASK',
    replyToMessageId: null,
    threadId: messageId,
    contextRefs: [],
    contextPacketRef: null,
    expiresAt: null,
    priority: 'NORMAL',
    status: 'DELIVERED',
    deliveredAt: nowIso,
    readAt: null,
    processedAt: null,
    createdAt: nowIso,
    subject,
    body,
  });

  await context.stateStore.saveBacklogItem({
    id: backlogId,
    agentId: toId,
    priority: 'NORMAL',
    status: 'PROPOSED',
    originType: 'MESSAGE',
    originRef: messageId,
    blockedOnMessageId: null,
    blockedOnGrantRequestId: null,
    blockedOnPromotionRequestId: null,
    blockedOnAccountBindingRequestId: null,
    estimatedEffort: 'PT15M',
    deadline: null,
    acceptedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: nowIso,
    title: subject,
    description: body,
  });

  return { messageId, backlogId, nextAgentId: toId };
}

/** Read the most-recent inbound TASK message for this agent (any status). */
export async function loadInboundTask(
  context: ActionExecutionContext,
): Promise<{ subject: string; body: string } | null> {
  const inbox = await context.stateStore.listMessagesForRecipient('AGENT', context.agent.id);
  // Pick the most recent TASK (handlers run after ProcessMessage marks it PROCESSED).
  const tasks = inbox.filter((m) => m.kind === 'TASK').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const m = tasks[0];
  return m ? { subject: m.subject, body: m.body } : null;
}

/** Best-effort JSON parse for inbound task bodies. Returns {} on parse error. */
export function parseInboundJson(body: string | undefined | null): Record<string, unknown> {
  if (!body) return {};
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Resolve a playbook for the given slug, returning null when no resolver is
 *  configured or no playbook matches. Logs failures non-fatally. */
export async function tryResolvePlaybook(
  resolver: KagglePlaybookResolver | undefined,
  slug: string,
  presetIndex: number,
  variables: Record<string, unknown>,
  log: (m: string) => void,
): Promise<KagglePlaybook | null> {
  if (!resolver) return null;
  try {
    return await resolver(slug, { presetIndex, variables });
  } catch (err) {
    log(`playbookResolver threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Resolve the catch-all (`*`) playbook ONCE at handler creation and return
 *  its operational defaults (top-N picks, kernel poll cadence). Falls back
 *  to historical hard-coded values when no resolver is wired or no catch-all
 *  matches — keeps tests/examples that don't seed the DB working. */
export async function loadOperationalDefaults(
  resolver: KagglePlaybookResolver | undefined,
  log: (m: string) => void,
): Promise<OperationalDefaults> {
  const HARD_DEFAULTS: OperationalDefaults = {
    topNAgentic: 5,
    topNDeterministic: 3,
    pollIntervalMs: 10_000,
    pollTimeoutMs: 300_000,
  };
  if (!resolver) return HARD_DEFAULTS;
  try {
    const pb = await resolver('');
    const cfg = pb?.config ?? {};
    return {
      topNAgentic: cfg.topNAgentic ?? HARD_DEFAULTS.topNAgentic,
      topNDeterministic: cfg.topNDeterministic ?? HARD_DEFAULTS.topNDeterministic,
      pollIntervalMs: (cfg.pollIntervalSec ?? 10) * 1000,
      pollTimeoutMs: (cfg.pollTimeoutSec ?? 300) * 1000,
    };
  } catch (err) {
    log(`loadOperationalDefaults failed: ${err instanceof Error ? err.message : String(err)}`);
    return HARD_DEFAULTS;
  }
}
