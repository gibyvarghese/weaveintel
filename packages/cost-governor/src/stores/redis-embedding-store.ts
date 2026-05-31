/**
 * Redis-backed EmbeddingStore.
 *
 * Layout:
 *   emb:<toolKey>          STRING — JSON of ToolEmbedding (sans toolKey)
 *   emb:index              SET    — member = toolKey (for getAll)
 */
import type { RedisClientType } from 'redis';
import type { EmbeddingStore, ToolEmbedding } from '../intent-rag.js';

export interface WeaveRedisEmbeddingStoreOptions {
  client: RedisClientType;
  keyPrefix?: string;
}

export function weaveRedisEmbeddingStore(opts: WeaveRedisEmbeddingStoreOptions): EmbeddingStore {
  const prefix = opts.keyPrefix ?? '';
  const client = opts.client;
  const k = (s: string) => `${prefix}${s}`;

  return {
    async get(toolKey: string): Promise<ToolEmbedding | null> {
      const raw = await client.get(k(`emb:${toolKey}`));
      if (!raw) return null;
      try {
        const rest = JSON.parse(raw) as Omit<ToolEmbedding, 'toolKey'>;
        return { toolKey, ...rest };
      } catch {
        return null;
      }
    },
    async getAll(): Promise<ReadonlyArray<ToolEmbedding>> {
      const keys = await client.sMembers(k('emb:index'));
      if (keys.length === 0) return [];
      const blobs = await client.mGet(keys.map((id) => k(`emb:${id}`)));
      const out: ToolEmbedding[] = [];
      for (let i = 0; i < keys.length; i++) {
        const b = blobs[i];
        const key = keys[i];
        if (!b || !key) continue;
        try {
          const rest = JSON.parse(b) as Omit<ToolEmbedding, 'toolKey'>;
          out.push({ toolKey: key, ...rest });
        } catch { /* skip */ }
      }
      return out;
    },
    async upsert(embedding: ToolEmbedding): Promise<void> {
      const { toolKey, ...rest } = embedding;
      // ensure vector is plain array (strip readonly modifier for JSON)
      const blob = { ...rest, vector: [...rest.vector] };
      await client.set(k(`emb:${toolKey}`), JSON.stringify(blob));
      await client.sAdd(k('emb:index'), toolKey);
    },
  };
}
