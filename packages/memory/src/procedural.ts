/**
 * @weaveintel/memory — Procedural memory
 *
 * Stores agent instruction deltas — proposed changes to an agent's default
 * behaviour derived from user feedback. A curator step (run during consolidation)
 * proposes updates; they are held in 'proposed' status until approved by a
 * human via @weaveintel/human-tasks.
 *
 * Lifecycle:
 *   1. Curator analyses episodic/semantic memory → detects behavioural patterns
 *   2. `proposeProceduralUpdate()` creates a ProceduralMemoryEntry (status: 'proposed')
 *      and submits an ApprovalTask to the human-tasks queue
 *   3. On human approval, `applyApprovedProcedural()` marks the entry as 'applied'
 *      and returns the instruction delta for the caller to write into the agent's
 *      skills/prompts store
 *   4. On rejection, the entry is marked 'rejected' and ignored
 */

import type { ExecutionContext, MemoryEntry, MemoryStore, ApprovalTask } from '@weaveintel/core';
import {
  createApprovalTask,
  type HumanTaskRepository,
} from '@weaveintel/human-tasks';

export interface ProceduralMemoryMetadata {
  /** The proposed change to the agent's instruction / system prompt. */
  instructionDelta: string;
  /** Which agent this instruction applies to. */
  agentId: string;
  /** Source of the proposal (e.g. 'consolidation-curator', 'user-feedback'). */
  proposedBy: string;
  /** Workflow status. */
  status: 'proposed' | 'approved' | 'rejected' | 'applied';
  /** ID of the human-tasks ApprovalTask created for this proposal. */
  humanTaskId?: string;
  /** ISO timestamp when the instruction was applied. */
  appliedAt?: string;
  /** Confidence score (0–1) from the curator. */
  confidence?: number;
}

/** A MemoryEntry of type 'procedural' — carries an instruction delta. */
export type ProceduralMemoryEntry = MemoryEntry & {
  type: 'procedural';
  metadata: ProceduralMemoryMetadata;
};

export function isProceduralEntry(entry: MemoryEntry): entry is ProceduralMemoryEntry {
  return entry.type === 'procedural';
}

/**
 * Build a ProceduralMemoryEntry without persisting it.
 * Call `store.write(ctx, [entry])` to persist.
 */
export function createProceduralEntry(opts: {
  id?: string;
  agentId: string;
  instructionDelta: string;
  proposedBy: string;
  confidence?: number;
  userId?: string;
  tenantId?: string;
  sessionId?: string;
}): ProceduralMemoryEntry {
  const now = new Date().toISOString();
  return {
    id: opts.id ?? `proc:${opts.agentId}:${Date.now()}`,
    type: 'procedural',
    content: opts.instructionDelta,
    metadata: {
      instructionDelta: opts.instructionDelta,
      agentId: opts.agentId,
      proposedBy: opts.proposedBy,
      status: 'proposed',
      confidence: opts.confidence ?? 0.7,
    },
    createdAt: now,
    validAt: now,
    importance: 0.9, // procedural entries are high-value
    userId: opts.userId,
    tenantId: opts.tenantId,
    sessionId: opts.sessionId,
  };
}

export interface ProposeProceduralUpdateOptions {
  store: MemoryStore;
  taskRepo: HumanTaskRepository;
  ctx: ExecutionContext;
  agentId: string;
  instructionDelta: string;
  proposedBy: string;
  confidence?: number;
  slaHours?: number;
  assignee?: string;
}

/**
 * Create a procedural memory entry (status: 'proposed') and submit it for
 * human approval. Returns both the stored entry and the created task.
 */
export async function proposeProceduralUpdate(
  opts: ProposeProceduralUpdateOptions,
): Promise<{ entry: ProceduralMemoryEntry; task: ApprovalTask }> {
  const entry = createProceduralEntry({
    agentId: opts.agentId,
    instructionDelta: opts.instructionDelta,
    proposedBy: opts.proposedBy,
    confidence: opts.confidence,
    userId: opts.ctx.userId,
    tenantId: opts.ctx.tenantId,
  });

  const slaDeadline = opts.slaHours
    ? new Date(Date.now() + opts.slaHours * 3600_000).toISOString()
    : undefined;

  const task = createApprovalTask({
    title: `Approve procedural memory update for agent ${opts.agentId}`,
    description: `Proposed instruction delta:\n\n${opts.instructionDelta}`,
    action: 'apply_procedural_memory_delta',
    context: {
      entryId: entry.id,
      agentId: opts.agentId,
      proposedBy: opts.proposedBy,
      confidence: opts.confidence ?? 0.7,
    },
    riskLevel: 'medium',
    priority: 'normal',
    assignee: opts.assignee,
    slaDeadline,
  });

  // Stamp the humanTaskId before persisting
  const entryWithTask: ProceduralMemoryEntry = {
    ...entry,
    metadata: {
      ...(entry.metadata as ProceduralMemoryMetadata),
      humanTaskId: task.id,
    },
  };

  await opts.store.write(opts.ctx, [entryWithTask]);
  await opts.taskRepo.save(task);

  return { entry: entryWithTask, task };
}

export interface ApplyApprovedProceduralOptions {
  store: MemoryStore;
  taskRepo: HumanTaskRepository;
  ctx: ExecutionContext;
  entryId: string;
}

/**
 * Called when a human approves a procedural update task.
 * Marks the entry as 'applied' and returns the instruction delta.
 * Returns null if the entry is not found or was already applied/rejected.
 */
export async function applyApprovedProcedural(
  opts: ApplyApprovedProceduralOptions,
): Promise<string | null> {
  // Load all procedural entries and find by id (topK high to avoid paging)
  const results = await opts.store.query(opts.ctx, {
    type: 'procedural',
    topK: 1000,
    filter: { userId: opts.ctx.userId, tenantId: opts.ctx.tenantId },
  });
  const entry = results.find((e) => e.id === opts.entryId);
  if (!entry || !isProceduralEntry(entry)) return null;
  if (entry.metadata.status !== 'proposed') return null;

  const now = new Date().toISOString();
  const applied: ProceduralMemoryEntry = {
    ...entry,
    metadata: {
      ...entry.metadata,
      status: 'applied',
      appliedAt: now,
    },
  };
  await opts.store.write(opts.ctx, [applied]);
  return entry.metadata.instructionDelta;
}

/**
 * Curator: scans semantic memories for behavioural patterns and proposes
 * procedural updates. Called from the consolidation pipeline.
 *
 * This is a lightweight heuristic pass — richer analysis would use an LLM.
 */
export interface CuratorOptions {
  store: MemoryStore;
  taskRepo: HumanTaskRepository;
  ctx: ExecutionContext;
  agentId: string;
  /** Max number of proposals to emit per run. Defaults to 3. */
  maxProposals?: number;
}

export interface CuratorResult {
  proposed: number;
  proposals: Array<{ delta: string; confidence: number }>;
}

export async function runProceduralCurator(opts: CuratorOptions): Promise<CuratorResult> {
  const { store, taskRepo, ctx, agentId, maxProposals = 3 } = opts;

  // Load recent semantic memories for pattern detection
  const memories = await store.query(ctx, {
    type: 'semantic',
    topK: 100,
    filter: { userId: ctx.userId, tenantId: ctx.tenantId },
  });

  const proposals: Array<{ delta: string; confidence: number }> = [];

  // Heuristic: detect repeated preferences
  const counts = new Map<string, number>();
  for (const mem of memories) {
    const content = mem.content.toLowerCase();
    if (content.includes('prefer') || content.includes('always') || content.includes('never') || content.includes('please')) {
      const key = content.slice(0, 80);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  // Memories mentioned ≥ 2 times are strong preference signals
  for (const [, mem] of memories.entries()) {
    if (proposals.length >= maxProposals) break;
    const content = mem.content.toLowerCase();
    if (content.includes('prefer') || content.includes('always') || content.includes('never')) {
      const key = content.slice(0, 80);
      if ((counts.get(key) ?? 0) >= 2) {
        const delta = `When responding to this user: ${mem.content}`;
        proposals.push({ delta, confidence: 0.75 });
        counts.delete(key); // avoid duplicates
      }
    }
  }

  // Submit proposals to human-tasks
  for (const proposal of proposals) {
    await proposeProceduralUpdate({
      store,
      taskRepo,
      ctx,
      agentId,
      instructionDelta: proposal.delta,
      proposedBy: 'procedural-curator',
      confidence: proposal.confidence,
    });
  }

  return { proposed: proposals.length, proposals };
}
