/**
 * DynamoDB-backed EmbeddingStore.
 *
 * Caller provides a DynamoDBDocumentClient and a table name. Schema (operator
 * provisions out-of-band):
 *   embeddingTable: PK = toolKey (S)
 *
 * getAll() uses a paginated Scan — acceptable for tool-catalog sizes (10s-100s
 * of tools). For huge catalogs, consider an auxiliary index table.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  GetCommand,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type { EmbeddingStore, ToolEmbedding } from '../intent-rag.js';

export interface WeaveDynamoDbEmbeddingStoreOptions {
  client: DynamoDBDocumentClient;
  embeddingTable: string;
}

export function weaveDynamoDbEmbeddingStore(opts: WeaveDynamoDbEmbeddingStoreOptions): EmbeddingStore {
  const { client, embeddingTable } = opts;

  return {
    async get(toolKey: string): Promise<ToolEmbedding | null> {
      const res = await client.send(new GetCommand({
        TableName: embeddingTable,
        Key: { toolKey },
      }));
      if (!res.Item) return null;
      return itemToEmbedding(res.Item as Record<string, unknown>);
    },
    async getAll(): Promise<ReadonlyArray<ToolEmbedding>> {
      const out: ToolEmbedding[] = [];
      let exclusive: Record<string, unknown> | undefined;
      do {
        const res = await client.send(new ScanCommand({
          TableName: embeddingTable,
          ...(exclusive ? { ExclusiveStartKey: exclusive } : {}),
        }));
        for (const item of (res.Items ?? []) as Record<string, unknown>[]) {
          out.push(itemToEmbedding(item));
        }
        exclusive = res.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (exclusive);
      return out;
    },
    async upsert(embedding: ToolEmbedding): Promise<void> {
      const item: Record<string, unknown> = {
        toolKey: embedding.toolKey,
        modelId: embedding.modelId,
        dimension: embedding.dimension,
        vector: [...embedding.vector],
        descriptionHash: embedding.descriptionHash,
      };
      await client.send(new PutCommand({
        TableName: embeddingTable,
        Item: item as unknown as Record<string, unknown>,
      }));
    },
  };
}

function itemToEmbedding(item: Record<string, unknown>): ToolEmbedding {
  return {
    toolKey: (item['toolKey'] as string) ?? '',
    modelId: (item['modelId'] as string) ?? '',
    dimension: (item['dimension'] as number) ?? 0,
    vector: (item['vector'] as number[]) ?? [],
    descriptionHash: (item['descriptionHash'] as string) ?? '',
  };
}
