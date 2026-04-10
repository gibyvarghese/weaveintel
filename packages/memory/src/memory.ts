/**
 * @weaveintel/memory — In-memory implementations
 *
 * Provides conversation memory (message history with optional summarization),
 * semantic memory (embedding-based recall), and entity memory (named facts).
 * All backed by in-memory storage. Production deployments can use the same
 * interfaces with persistent stores (Redis, Postgres, etc.).
 */

import type {
  MemoryEntry,
  MemoryType,
  MemoryStore,
  MemoryQuery,
  MemoryFilter,
  ConversationMemory,
  SemanticMemory,
  EntityMemory,
  ExecutionContext,
  EmbeddingModel,
  AgentMemory,
  Message,
} from '@weaveintel/core';

// ─── In-memory store ─────────────────────────────────────────

export function createInMemoryStore(): MemoryStore {
  const entries = new Map<string, MemoryEntry>();

  function matchesFilter(entry: MemoryEntry, filter?: MemoryFilter): boolean {
    if (!filter) return true;
    if (filter.tenantId && entry.tenantId !== filter.tenantId) return false;
    if (filter.userId && entry.userId !== filter.userId) return false;
    if (filter.sessionId && entry.sessionId !== filter.sessionId) return false;
    if (filter.types && !filter.types.includes(entry.type)) return false;
    if (filter.after && entry.createdAt < filter.after) return false;
    if (filter.before && entry.createdAt > filter.before) return false;
    return true;
  }

  return {
    async write(_ctx: ExecutionContext, newEntries: MemoryEntry[]): Promise<void> {
      for (const entry of newEntries) {
        entries.set(entry.id, entry);
      }
    },

    async query(_ctx: ExecutionContext, options: MemoryQuery): Promise<MemoryEntry[]> {
      let results = [...entries.values()];

      if (options.type) {
        results = results.filter((e) => e.type === options.type);
      }
      results = results.filter((e) => matchesFilter(e, options.filter));

      // If embedding-based query, do cosine similarity
      if (options.embedding) {
        const queryEmb = options.embedding;
        results = results
          .filter((e) => e.embedding)
          .map((e) => ({
            entry: e,
            score: cosineSimilarity(queryEmb, e.embedding!),
          }))
          .filter((r) => !options.minScore || r.score >= options.minScore)
          .sort((a, b) => b.score - a.score)
          .slice(0, options.topK ?? 10)
          .map((r) => ({ ...r.entry, score: r.score }));
      } else {
        // Simple text matching fallback
        if (options.query) {
          const q = options.query.toLowerCase();
          results = results.filter((e) => e.content.toLowerCase().includes(q));
        }
        results = results.slice(0, options.topK ?? 10);
      }

      return results;
    },

    async delete(_ctx: ExecutionContext, ids: string[]): Promise<void> {
      for (const id of ids) {
        entries.delete(id);
      }
    },

    async clear(_ctx: ExecutionContext, filter?: MemoryFilter): Promise<void> {
      if (!filter) {
        entries.clear();
        return;
      }
      for (const [id, entry] of entries) {
        if (matchesFilter(entry, filter)) {
          entries.delete(id);
        }
      }
    },
  };
}

// ─── Conversation memory ─────────────────────────────────────

export function createConversationMemory(opts?: {
  maxHistory?: number;
}): ConversationMemory & AgentMemory {
  const messages: Message[] = [];
  const maxHistory = opts?.maxHistory ?? 100;

  return {
    async addMessage(_ctx: ExecutionContext, msg: Message | string, content?: string, metadata?: Record<string, unknown>): Promise<void> {
      if (typeof msg === 'string') {
        // Called as addMessage(ctx, role, content, metadata)
        messages.push({ role: msg as Message['role'], content: content! });
      } else {
        messages.push(msg);
      }
      // Trim if too long
      while (messages.length > maxHistory) {
        messages.shift();
      }
    },

    async getMessages(_ctx: ExecutionContext, limit?: number): Promise<Message[]> {
      if (limit) return messages.slice(-limit);
      return [...messages];
    },

    async getHistory(_ctx: ExecutionContext, limit?: number): Promise<MemoryEntry[]> {
      const slice = limit ? messages.slice(-limit) : messages;
      return slice.map((m, i) => ({
        id: `msg_${i}`,
        type: 'conversation' as MemoryType,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        metadata: { role: m.role },
        createdAt: new Date().toISOString(),
      }));
    },

    async clear(_ctx: ExecutionContext): Promise<void> {
      messages.length = 0;
    },
  };
}

// ─── Semantic memory ─────────────────────────────────────────

export function createSemanticMemory(
  embeddingModel: EmbeddingModel,
  store?: MemoryStore,
): SemanticMemory {
  const memStore = store ?? createInMemoryStore();
  let idCounter = 0;

  return {
    async store(ctx: ExecutionContext, content: string, metadata?: Record<string, unknown>): Promise<void> {
      const embeddingResponse = await embeddingModel.embed(ctx, { input: [content] });
      const entry: MemoryEntry = {
        id: `sem_${++idCounter}`,
        type: 'semantic',
        content,
        metadata: metadata ?? {},
        embedding: embeddingResponse.embeddings[0],
        createdAt: new Date().toISOString(),
        tenantId: ctx.tenantId,
        userId: ctx.userId,
      };
      await memStore.write(ctx, [entry]);
    },

    async recall(ctx: ExecutionContext, query: string, topK?: number): Promise<MemoryEntry[]> {
      const embeddingResponse = await embeddingModel.embed(ctx, { input: [query] });
      return memStore.query(ctx, {
        type: 'semantic',
        embedding: embeddingResponse.embeddings[0],
        topK: topK ?? 5,
      });
    },
  };
}

// ─── Entity memory ───────────────────────────────────────────

export function createEntityMemory(store?: MemoryStore): EntityMemory {
  const memStore = store ?? createInMemoryStore();

  return {
    async upsertEntity(ctx: ExecutionContext, name: string, facts: Record<string, unknown>): Promise<void> {
      const existing = await memStore.query(ctx, {
        type: 'entity',
        query: name,
        topK: 1,
      });
      const entityEntry: MemoryEntry = {
        id: existing[0]?.id ?? `entity_${name}`,
        type: 'entity',
        content: name,
        metadata: { ...existing[0]?.metadata, ...facts },
        createdAt: existing[0]?.createdAt ?? new Date().toISOString(),
        tenantId: ctx.tenantId,
        userId: ctx.userId,
      };
      await memStore.write(ctx, [entityEntry]);
    },

    async getEntity(ctx: ExecutionContext, name: string): Promise<MemoryEntry | undefined> {
      const results = await memStore.query(ctx, {
        type: 'entity',
        query: name,
        topK: 1,
      });
      return results.find((e) => e.content === name);
    },

    async searchEntities(ctx: ExecutionContext, query: string): Promise<MemoryEntry[]> {
      return memStore.query(ctx, {
        type: 'entity',
        query,
        topK: 10,
      });
    },
  };
}

// ─── Cosine similarity utility ───────────────────────────────

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
