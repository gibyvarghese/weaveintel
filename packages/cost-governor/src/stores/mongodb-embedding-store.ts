/**
 * MongoDB-backed EmbeddingStore. _id = toolKey for natural upsert.
 */
import type { Collection, Db } from 'mongodb';
import type { EmbeddingStore, ToolEmbedding } from '../intent-rag.js';

interface Doc {
  _id: string;
  modelId: string;
  dimension: number;
  vector: number[];
  descriptionHash: string;
}

function docToEmbedding(d: Doc): ToolEmbedding {
  return {
    toolKey: d._id,
    modelId: d.modelId,
    dimension: d.dimension,
    vector: d.vector,
    descriptionHash: d.descriptionHash,
  };
}

export interface WeaveMongoDbEmbeddingStoreOptions {
  db: Db;
  collectionName?: string;
}

export async function weaveMongoDbEmbeddingStore(opts: WeaveMongoDbEmbeddingStoreOptions): Promise<EmbeddingStore> {
  const coll: Collection<Doc> = opts.db.collection<Doc>(opts.collectionName ?? 'tool_embeddings');
  return {
    async get(toolKey: string): Promise<ToolEmbedding | null> {
      const d = await coll.findOne({ _id: toolKey });
      return d ? docToEmbedding(d) : null;
    },
    async getAll(): Promise<ReadonlyArray<ToolEmbedding>> {
      const docs = await coll.find({}).toArray();
      return docs.map(docToEmbedding);
    },
    async upsert(embedding: ToolEmbedding): Promise<void> {
      const doc: Doc = {
        _id: embedding.toolKey,
        modelId: embedding.modelId,
        dimension: embedding.dimension,
        vector: [...embedding.vector],
        descriptionHash: embedding.descriptionHash,
      };
      await coll.updateOne(
        { _id: embedding.toolKey },
        {
          $set: {
            modelId: doc.modelId,
            dimension: doc.dimension,
            vector: doc.vector,
            descriptionHash: doc.descriptionHash,
          },
        },
        { upsert: true },
      );
    },
  };
}
