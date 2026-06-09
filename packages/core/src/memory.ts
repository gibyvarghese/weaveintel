/**
 * @weaveintel/core — Memory contracts
 *
 * Why: Memory is a subsystem, not a single class. Different memory types
 * serve different needs: conversation history, semantic facts, entity knowledge,
 * episodic recall. Separating them allows independent storage, retrieval,
 * and retention policies.
 */

import type { ExecutionContext } from './context.js';

// ─── Memory entries ──────────────────────────────────────────

export interface MemoryEntry {
  readonly id: string;
  readonly type: MemoryType;
  readonly content: string;
  readonly metadata: Record<string, unknown>;
  readonly embedding?: readonly number[];
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly tenantId?: string;
  readonly userId?: string;
  readonly sessionId?: string;
  readonly score?: number;
  /** Salience weight 0–1 used for importance-based compaction and ranking. */
  readonly importance?: number;
  /** Bi-temporal: when this fact became true (ISO 8601). Defaults to createdAt. */
  readonly validAt?: string;
  /** Bi-temporal: when this fact was superseded / invalidated (ISO 8601). Null means still valid. */
  readonly invalidAt?: string;
}

export type MemoryType = 'conversation' | 'semantic' | 'episodic' | 'entity' | 'working' | 'procedural';

// ─── Memory store (backend-agnostic persistence) ─────────────

export interface MemoryStore {
  write(ctx: ExecutionContext, entries: MemoryEntry[]): Promise<void>;
  query(ctx: ExecutionContext, options: MemoryQuery): Promise<MemoryEntry[]>;
  delete(ctx: ExecutionContext, ids: string[]): Promise<void>;
  clear(ctx: ExecutionContext, filter?: MemoryFilter): Promise<void>;
}

export interface MemoryQuery {
  readonly type?: MemoryType;
  readonly query?: string;
  readonly embedding?: readonly number[];
  readonly topK?: number;
  readonly filter?: MemoryFilter;
  readonly minScore?: number;
  /** Bi-temporal: return only facts that were valid at this ISO 8601 timestamp.
   *  Entries where validAt <= asOf AND (invalidAt is null OR invalidAt > asOf). */
  readonly asOf?: string;
}

export interface MemoryFilter {
  readonly tenantId?: string;
  readonly userId?: string;
  readonly sessionId?: string;
  readonly types?: readonly MemoryType[];
  readonly after?: string;
  readonly before?: string;
}

// ─── Memory policy ───────────────────────────────────────────

export interface MemoryPolicy {
  /** Decide whether an entry should be persisted */
  shouldStore(ctx: ExecutionContext, entry: MemoryEntry): Promise<boolean>;

  /** Transform entry before storage (e.g., redaction) */
  beforeStore?(ctx: ExecutionContext, entry: MemoryEntry): Promise<MemoryEntry>;

  /** Retention rules */
  retentionPolicy?: MemoryRetentionPolicy;
}

export interface MemoryRetentionPolicy {
  readonly maxEntries?: number;
  readonly maxAge?: string; // ISO 8601 duration like "P30D"
  readonly compactionStrategy?: 'summarize' | 'drop_oldest' | 'drop_lowest_score';
}

// ─── High-level memory interfaces ────────────────────────────

export interface ConversationMemory {
  addMessage(
    ctx: ExecutionContext,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  getHistory(ctx: ExecutionContext, limit?: number): Promise<MemoryEntry[]>;
  summarize?(ctx: ExecutionContext): Promise<string>;
  clear(ctx: ExecutionContext): Promise<void>;
}

export interface SemanticMemory {
  store(ctx: ExecutionContext, content: string, metadata?: Record<string, unknown>): Promise<void>;
  recall(ctx: ExecutionContext, query: string, topK?: number): Promise<MemoryEntry[]>;
}

export interface EntityMemory {
  upsertEntity(
    ctx: ExecutionContext,
    name: string,
    facts: Record<string, unknown>,
  ): Promise<void>;
  getEntity(ctx: ExecutionContext, name: string): Promise<MemoryEntry | undefined>;
  searchEntities(ctx: ExecutionContext, query: string): Promise<MemoryEntry[]>;
}

export type WorkingMemoryPatch =
  | { op: 'set'; key: string; value: unknown }
  | { op: 'delete'; key: string }
  | { op: 'merge'; value: Record<string, unknown> };

export interface WorkingMemorySnapshot {
  readonly id: string;
  readonly agentId: string;
  readonly content: Record<string, unknown>;
  readonly createdAt: string;
  readonly metadata?: Record<string, unknown>;
}

export interface WorkingMemory {
  patch(
    ctx: ExecutionContext,
    agentId: string,
    operations: readonly WorkingMemoryPatch[],
    metadata?: Record<string, unknown>,
  ): Promise<WorkingMemorySnapshot>;
  checkpoint(
    ctx: ExecutionContext,
    agentId: string,
    metadata?: Record<string, unknown>,
  ): Promise<WorkingMemorySnapshot>;
  restore(ctx: ExecutionContext, agentId: string, snapshotId: string): Promise<WorkingMemorySnapshot | null>;
  getCurrent(ctx: ExecutionContext, agentId: string): Promise<WorkingMemorySnapshot | null>;
}

export interface CompressionInput {
  readonly agentId: string;
  readonly messages: readonly MemoryEntry[];
  readonly episodicEvents?: readonly MemoryEntry[];
  readonly workingState?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

export interface CompressionArtefact {
  readonly id: string;
  readonly compressorId: string;
  readonly agentId: string;
  readonly summary: string;
  readonly tokensEstimated: number;
  readonly sourceRefs: readonly string[];
  readonly createdAt: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ContextCompressor {
  readonly id: string;
  readonly name: string;
  describe(): string;
  compress(input: CompressionInput, ctx: ExecutionContext): Promise<CompressionArtefact>;
  render(
    artefacts: readonly CompressionArtefact[],
    tokenBudget: number,
    ctx: ExecutionContext,
  ): Promise<string>;
}

// ─── Memory consolidation ─────────────────────────────────────

export interface ConsolidationInput {
  readonly userId?: string;
  readonly sessionId?: string;
  readonly tenantId?: string;
  /** How many episodic entries to process per run. Defaults to 50. */
  readonly batchSize?: number;
}

export interface ConsolidationResult {
  readonly episodicRead: number;
  readonly factsExtracted: number;
  readonly factsDeduped: number;
  readonly factsWritten: number;
  readonly errors: readonly string[];
}

/**
 * Runs on the cold path (session-end, cron) to distil ephemeral episodic
 * entries into durable semantic facts via extraction → dedup → provenance.
 */
export interface MemoryConsolidator {
  consolidate(ctx: ExecutionContext, input: ConsolidationInput): Promise<ConsolidationResult>;
}
