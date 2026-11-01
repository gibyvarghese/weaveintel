// SPDX-License-Identifier: MIT
/**
 * Propose → review → promote: dual control for changing what other tenants get (GAPS G-WI-14,
 * platform-architecture §5.2 item 1 and §7.4 item 8).
 *
 * `promoteFork` and `setShareMode` change configuration for tenants other than the one that made
 * the fork. Calling them directly lets one person widen a customization to everyone. This module
 * puts a human review in between:
 *
 *   1. `proposeFork` records the change as an approval task on a `HumanTaskQueue` (the core port;
 *      `@weaveintel/human-tasks` implements it, in memory or on Postgres). The task carries the
 *      base (the current global default), the fork, the requested change and its blast radius, so
 *      the reviewer sees exactly what will happen.
 *   2. `decideForkProposal` applies the decision. Approval must come from someone other than the
 *      proposer, and it is refused if the fork (or, for a promotion, the global default) changed
 *      after the proposal: the reviewer approved what they saw, not what is there now. On approval
 *      it calls `promoteFork` or `setShareMode`; on rejection it only closes the task.
 */
import type { HumanDecision, HumanTask, HumanTaskQueue } from '@weaveintel/core';
import type { ShareMode } from './realm-record.js';
import type { Payload, RealmConfigStore } from './realm-store.js';
import type { RealmVersionLog } from './realm-version.js';
import { payloadOf, promoteFork, type BlastRadius } from './realm-share.js';

/** The change a proposal asks for. */
export type ForkChange =
  /** Publish the fork's content as the new global default for everyone. */
  | { readonly kind: 'promote' }
  /** Share the fork down the owner's tree. */
  | { readonly kind: 'share'; readonly shareMode: ShareMode };

/** What a fork-proposal task carries in `data.context`. */
export interface ForkProposalData {
  readonly kind: 'realm.fork_proposal';
  readonly version: 1;
  readonly family: string;
  readonly logicalKey: string;
  readonly forkId: string;
  readonly ownerTenantId: string;
  readonly proposedBy: string;
  readonly change: ForkChange;
  /** The global default the fork would replace (null when there is none). */
  readonly base: { readonly id: string; readonly contentHash: string; readonly payload: Payload } | null;
  /** The fork as proposed. */
  readonly fork: { readonly contentHash: string; readonly payload: Payload };
  readonly blastRadius?: BlastRadius;
  readonly note?: string;
}

export interface ProposeForkOptions {
  /** Where the review task goes. */
  readonly queue: HumanTaskQueue;
  /** Who should review (a person or a group id, as your task queue understands it). */
  readonly reviewer: string;
  /** Who is proposing. They cannot approve their own proposal. */
  readonly proposedBy: string;
  /** What to do on approval. Defaults to promoting the fork to the global default. */
  readonly change?: ForkChange;
  /**
   * Who the change reaches (from `blastRadius`). Required for a share, because a share's reach
   * depends on the owner's tree, which only the caller knows.
   */
  readonly blastRadius?: BlastRadius;
  readonly note?: string;
  readonly priority?: HumanTask['priority'];
  /** ISO-8601 time after which the review expires. */
  readonly slaDeadline?: string;
}

export class ForkProposalError extends Error {
  constructor(
    message: string,
    /** Machine-readable reason. */
    readonly code: 'not_a_fork' | 'not_found' | 'no_change' | 'blast_radius_required' | 'not_a_proposal' | 'not_open' | 'self_approval',
  ) {
    super(message);
    this.name = 'ForkProposalError';
  }
}

const OPEN_STATUSES: ReadonlySet<HumanTask['status']> = new Set(['pending', 'assigned', 'in-review']);

function isForkProposal(value: unknown): value is ForkProposalData {
  const v = value as Partial<ForkProposalData> | null | undefined;
  return !!v && v.kind === 'realm.fork_proposal' && v.version === 1 && typeof v.forkId === 'string';
}

/**
 * Open a review task asking for a fork to be promoted to the global default (or shared down the
 * tree). Nothing changes until `decideForkProposal` approves it.
 *
 * @param fork The tenant's fork, or just its id. The record is re-read from `store`, so the task
 *             describes what is stored, not what the caller passed.
 * @returns the review task's id.
 */
export async function proposeFork<T extends Payload>(
  store: RealmConfigStore<T>,
  family: string,
  fork: string | { readonly id: string },
  opts: ProposeForkOptions,
): Promise<string> {
  const forkId = typeof fork === 'string' ? fork : fork.id;
  const current = await store.get(forkId);
  if (!current) throw new ForkProposalError(`Realm record ${JSON.stringify(forkId)} not found`, 'not_found');
  if (current.realm !== 'tenant' || !current.ownerTenantId) {
    throw new ForkProposalError('Only a tenant-owned record can be proposed', 'not_a_fork');
  }
  const change: ForkChange = opts.change ?? { kind: 'promote' };
  if (change.kind === 'share') {
    if (change.shareMode === current.shareMode) {
      throw new ForkProposalError(`The record is already shared as '${change.shareMode}'`, 'no_change');
    }
    if (!opts.blastRadius) {
      throw new ForkProposalError('A share proposal needs its blast radius', 'blast_radius_required');
    }
  }

  const global = (await store.listAll([current.logicalKey])).find((r) => r.realm === 'global') ?? null;
  if (change.kind === 'promote' && global && global.contentHash === current.contentHash) {
    throw new ForkProposalError('The fork already matches the global default', 'no_change');
  }

  const data: ForkProposalData = {
    kind: 'realm.fork_proposal',
    version: 1,
    family,
    logicalKey: current.logicalKey,
    forkId: current.id,
    ownerTenantId: current.ownerTenantId,
    proposedBy: opts.proposedBy,
    change,
    base: global ? { id: global.id, contentHash: global.contentHash, payload: payloadOf(global as Record<string, unknown>) } : null,
    fork: { contentHash: current.contentHash, payload: payloadOf(current as Record<string, unknown>) },
    ...(opts.blastRadius ? { blastRadius: opts.blastRadius } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  };

  const title = change.kind === 'promote'
    ? `Promote ${family}/${current.logicalKey} from ${current.ownerTenantId} to the global default`
    : `Share ${family}/${current.logicalKey} from ${current.ownerTenantId} as '${change.shareMode}'`;
  const reach = opts.blastRadius
    ? `${opts.blastRadius.inheriting.length} tenant(s) would start using it; ${opts.blastRadius.shadowed.length} keep their own copy`
    : undefined;

  const task = await opts.queue.enqueue({
    type: 'approval',
    title,
    ...(opts.note ? { description: opts.note } : {}),
    status: 'pending',
    priority: opts.priority ?? 'normal',
    assignee: opts.reviewer,
    blocking: true,
    provenance: { createdBy: 'principal', sourceRef: `realm:${family}:${current.id}` },
    ...(opts.slaDeadline ? { slaDeadline: opts.slaDeadline } : {}),
    data: {
      action: change.kind === 'promote' ? 'realm.fork.promote' : 'realm.fork.share',
      context: data as unknown as Record<string, unknown>,
      riskLevel: 'high',
      ...(reach ? { estimatedImpact: reach } : {}),
    },
  });
  return task.id;
}

/** A reviewer's decision on a fork proposal. */
export interface ForkProposalDecision {
  readonly decidedBy: string;
  readonly approved: boolean;
  readonly reason?: string;
  readonly at?: string;
}

export type ForkProposalOutcome =
  | { readonly outcome: 'promoted'; readonly taskId: string; readonly contentHash: string }
  | { readonly outcome: 'shared'; readonly taskId: string; readonly shareMode: ShareMode }
  | { readonly outcome: 'rejected'; readonly taskId: string }
  /** Closed without applying: the fork or the global default changed after the proposal. */
  | { readonly outcome: 'stale'; readonly taskId: string; readonly reason: string };

export interface DecideForkProposalDeps<T extends Payload> {
  readonly store: RealmConfigStore<T>;
  readonly versionLog: RealmVersionLog<T>;
  readonly queue: HumanTaskQueue;
}

/**
 * Apply a reviewer's decision to a fork proposal.
 *
 * Approval runs `promoteFork` (or `setShareMode`) and completes the task. It is refused with
 * `self_approval` when the reviewer is the proposer, and closes the task as `stale` (applying
 * nothing) when the fork or the global default no longer matches what was proposed.
 */
export async function decideForkProposal<T extends Payload>(
  deps: DecideForkProposalDeps<T>,
  taskId: string,
  decision: ForkProposalDecision,
): Promise<ForkProposalOutcome> {
  const task = await deps.queue.get(taskId);
  const data = (task?.data as { context?: unknown } | undefined)?.context;
  if (!task || !isForkProposal(data)) throw new ForkProposalError(`Task ${JSON.stringify(taskId)} is not a fork proposal`, 'not_a_proposal');
  if (!OPEN_STATUSES.has(task.status)) throw new ForkProposalError(`Task ${JSON.stringify(taskId)} is already ${task.status}`, 'not_open');
  if (decision.decidedBy === data.proposedBy) {
    throw new ForkProposalError('The proposer cannot decide their own proposal', 'self_approval');
  }

  const at = decision.at ?? new Date().toISOString();
  const human = (verdict: string, reason?: string): HumanDecision => ({
    taskId,
    decidedBy: decision.decidedBy,
    decision: verdict,
    decidedAt: at,
    ...(reason ? { reason } : {}),
  });

  if (!decision.approved) {
    await deps.queue.reject(taskId, human('rejected', decision.reason));
    return { outcome: 'rejected', taskId };
  }

  // Re-check that the world still matches what the reviewer saw.
  const current = await deps.store.get(data.forkId);
  let stale: string | undefined;
  if (!current) stale = 'the fork was deleted after the proposal';
  else if (current.contentHash !== data.fork.contentHash) stale = 'the fork changed after the proposal';
  else if (data.change.kind === 'promote') {
    const global = (await deps.store.listAll([data.logicalKey])).find((r) => r.realm === 'global') ?? null;
    if ((global?.contentHash ?? null) !== (data.base?.contentHash ?? null)) stale = 'the global default changed after the proposal';
  }
  if (stale || !current) {
    const reason = stale ?? 'the fork was deleted after the proposal';
    await deps.queue.reject(taskId, human('stale', reason));
    return { outcome: 'stale', taskId, reason };
  }

  if (data.change.kind === 'promote') {
    const { contentHash } = await promoteFork(
      deps.store,
      deps.versionLog,
      data.family,
      current as unknown as Record<string, unknown> & { logicalKey: string },
      { publishedBy: decision.decidedBy, note: `promote (proposal ${taskId} by ${data.proposedBy})`, at },
    );
    await deps.queue.complete(taskId, { ...human('approved', decision.reason), data: { contentHash } });
    return { outcome: 'promoted', taskId, contentHash };
  }

  await deps.store.setShareMode(current.id, data.change.shareMode);
  await deps.queue.complete(taskId, { ...human('approved', decision.reason), data: { shareMode: data.change.shareMode } });
  return { outcome: 'shared', taskId, shareMode: data.change.shareMode };
}
