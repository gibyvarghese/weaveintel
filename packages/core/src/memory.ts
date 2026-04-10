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
}

export type MemoryType = 'conversation' | 'semantic' | 'episodic' | 'entity' | 'working';

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
