// @weaveintel/graph — Entity nodes & relationship edges

export interface EntityNode {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly properties: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RelationshipEdge {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: string;
  readonly weight: number;
  readonly properties: Record<string, unknown>;
  readonly createdAt: number;
}

export function createEntityNode(
  id: string,
  type: string,
  name: string,
  properties: Record<string, unknown> = {},
): EntityNode {
  const now = Date.now();
  return { id, type, name, properties, createdAt: now, updatedAt: now };
}

export function createRelationshipEdge(
  sourceId: string,
  targetId: string,
  type: string,
  weight: number = 1.0,
  properties: Record<string, unknown> = {},
): RelationshipEdge {
  return {
    id: `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sourceId, targetId, type, weight, properties, createdAt: Date.now(),
  };
}
