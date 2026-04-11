// @weaveintel/graph — Graph-assisted retrieval

import type { EntityNode, RelationshipEdge } from './entity.js';
import type { GraphMemoryStore } from './store.js';

export interface GraphRetrievalResult {
  readonly node: EntityNode;
  readonly score: number;
  readonly path: readonly string[];
  readonly connectedEdges: readonly RelationshipEdge[];
}

export interface GraphRetriever {
  retrieve(query: string, maxResults?: number): readonly GraphRetrievalResult[];
  retrieveByEntity(entityId: string, maxDepth?: number, maxResults?: number): readonly GraphRetrievalResult[];
}

export function createGraphRetriever(store: GraphMemoryStore): GraphRetriever {
  return {
    retrieve(query, maxResults = 10) {
      const matches = store.searchNodes(query);
      const results: GraphRetrievalResult[] = [];

      for (const node of matches.slice(0, maxResults)) {
        const edges = [...store.getEdgesFrom(node.id), ...store.getEdgesTo(node.id)];
        // Simple scoring: name match gets higher score
        const nameScore = node.name.toLowerCase().includes(query.toLowerCase()) ? 1.0 : 0.5;
        results.push({ node, score: nameScore, path: [node.id], connectedEdges: edges });
      }

      return results.sort((a, b) => b.score - a.score);
    },

    retrieveByEntity(entityId, maxDepth = 2, maxResults = 20) {
      const neighbors = store.getNeighbors(entityId, maxDepth);
      const results: GraphRetrievalResult[] = [];

      for (const neighbor of neighbors.slice(0, maxResults)) {
        const edges = store.getEdgesBetween(entityId, neighbor.id);
        const directEdges = [...store.getEdgesFrom(neighbor.id), ...store.getEdgesTo(neighbor.id)];
        const score = edges.length > 0 ? 1.0 / (1 + edges.length) : 0.1;
        results.push({ node: neighbor, score, path: [entityId, neighbor.id], connectedEdges: directEdges });
      }

      return results.sort((a, b) => b.score - a.score);
    },
  };
}
