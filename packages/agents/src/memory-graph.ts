/**
 * @weaveintel/agents — P4-3: Knowledge graph memory tools
 *
 * `createGraphMemoryToolSet(store)` exposes 4 tools backed by a
 * `GraphMemoryStore` (from @weaveintel/graph):
 *
 *   graph_entity_add         — add/upsert an entity node
 *   graph_entity_search      — full-text search across nodes
 *   graph_relate             — create a directed relationship edge
 *   graph_recall_neighbours  — traverse neighbour graph up to N hops
 *
 * The store is caller-supplied, so any backing (in-memory, SQLite, etc.)
 * can be used without coupling this package to a persistence layer.
 *
 * Usage:
 * ```ts
 * import { createGraphMemoryStore } from '@weaveintel/graph';
 * import { createGraphMemoryToolSet } from '@weaveintel/agents';
 *
 * const store = createGraphMemoryStore();
 * const tools = createGraphMemoryToolSet(store);
 * const agent = weaveAgent({ model, tools: weaveMergeTools(baseReg, tools) });
 * ```
 */

import { weaveTool, weaveToolRegistry } from '@weaveintel/core';
import type { Tool, ToolRegistry } from '@weaveintel/core';
import type { GraphMemoryStore } from '@weaveintel/graph';
import { createEntityNode, createRelationshipEdge } from '@weaveintel/graph';

export type { GraphMemoryStore };

// ─── Factory ───────────────────────────────────────────────────

/**
 * Build the 4 graph memory tools backed by the supplied `GraphMemoryStore`.
 *
 * Returns an array of `Tool` instances ready to be registered in any
 * `ToolRegistry`, or use `createGraphMemoryToolRegistry(store)` for a
 * pre-built registry.
 */
export function createGraphMemoryToolSet(store: GraphMemoryStore): Tool[] {
  // ── graph_entity_add ─────────────────────────────────────────
  const entityAddTool = weaveTool({
    name: 'graph_entity_add',
    description:
      'Add or update an entity node in the knowledge graph. Use this to store structured facts about people, organisations, concepts, or objects.',
    parameters: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description: 'Unique entity identifier (e.g. "user:alice", "org:acme"). If omitted a stable ID is derived from type+name.',
        },
        type: {
          type: 'string',
          description: 'Entity class (e.g. "person", "organisation", "product", "concept")',
        },
        name: {
          type: 'string',
          description: 'Human-readable name for this entity',
        },
        properties: {
          type: 'object',
          description: 'Arbitrary key-value facts about this entity',
        },
      },
      required: ['type', 'name'],
    },
    tags: ['memory', 'graph', 'knowledge'],
    execute: async (args) => {
      const { id: rawId, type, name, properties = {} } = args as {
        id?: string;
        type: string;
        name: string;
        properties?: Record<string, unknown>;
      };

      const id = rawId ?? `${type}:${name.toLowerCase().replace(/\s+/g, '-')}`;
      const existing = store.getNode(id);

      if (existing) {
        // Upsert: merge properties and bump updatedAt
        const merged = createEntityNode(id, type, name, { ...existing.properties, ...properties });
        store.removeNode(id);
        store.addNode(merged);
        return JSON.stringify({ ok: true, action: 'updated', id, type, name, propertyCount: Object.keys(merged.properties).length });
      }

      const node = createEntityNode(id, type, name, properties);
      store.addNode(node);
      return JSON.stringify({ ok: true, action: 'created', id, type, name, nodeCount: store.nodeCount() });
    },
  });

  // ── graph_entity_search ───────────────────────────────────────
  const entitySearchTool = weaveTool({
    name: 'graph_entity_search',
    description:
      'Search the knowledge graph for entity nodes matching a query string. Searches across name and type fields. Optionally filter by entity type.',
    parameters: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Natural language or keyword search across entity names and types',
        },
        type: {
          type: 'string',
          description: 'Optional: restrict results to this entity type (e.g. "person", "product")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10, max: 50)',
        },
      },
      required: ['query'],
    },
    tags: ['memory', 'graph', 'search'],
    execute: async (args) => {
      const { query, type: typeFilter, limit: rawLimit } = args as {
        query: string;
        type?: string;
        limit?: number;
      };

      const limit = Math.max(1, Math.min(50, Number(rawLimit ?? 10)));
      let results = [...store.searchNodes(query)];

      if (typeFilter) {
        results = results.filter((n) => n.type === typeFilter);
      }

      results = results.slice(0, limit);

      return JSON.stringify({
        query,
        typeFilter: typeFilter ?? null,
        matchCount: results.length,
        nodes: results.map((n) => ({
          id: n.id,
          type: n.type,
          name: n.name,
          properties: n.properties,
          createdAt: n.createdAt,
          updatedAt: n.updatedAt,
        })),
      }, null, 2);
    },
  });

  // ── graph_relate ─────────────────────────────────────────────
  const relateTool = weaveTool({
    name: 'graph_relate',
    description:
      'Create a directed relationship edge between two entity nodes in the knowledge graph. Both source and target entities must exist (use graph_entity_add first).',
    parameters: {
      type: 'object' as const,
      properties: {
        sourceId: {
          type: 'string',
          description: 'ID of the source entity node',
        },
        targetId: {
          type: 'string',
          description: 'ID of the target entity node',
        },
        type: {
          type: 'string',
          description: 'Relationship type label (e.g. "works_at", "owns", "knows", "part_of")',
        },
        weight: {
          type: 'number',
          description: 'Relationship strength (0.0–1.0, default 1.0)',
        },
        properties: {
          type: 'object',
          description: 'Additional metadata about this relationship',
        },
      },
      required: ['sourceId', 'targetId', 'type'],
    },
    tags: ['memory', 'graph', 'relationship'],
    execute: async (args) => {
      const { sourceId, targetId, type, weight = 1.0, properties = {} } = args as {
        sourceId: string;
        targetId: string;
        type: string;
        weight?: number;
        properties?: Record<string, unknown>;
      };

      const source = store.getNode(sourceId);
      const target = store.getNode(targetId);

      if (!source) {
        return JSON.stringify({ ok: false, error: `Source entity not found: ${sourceId}. Add it with graph_entity_add first.` });
      }
      if (!target) {
        return JSON.stringify({ ok: false, error: `Target entity not found: ${targetId}. Add it with graph_entity_add first.` });
      }

      const clampedWeight = Math.max(0, Math.min(1, Number.isNaN(weight) ? 0 : weight));
      const edge = createRelationshipEdge(sourceId, targetId, type, clampedWeight, properties);
      store.addEdge(edge);

      return JSON.stringify({
        ok: true,
        edgeId: edge.id,
        source: { id: source.id, name: source.name },
        target: { id: target.id, name: target.name },
        type,
        weight: clampedWeight,
        edgeCount: store.edgeCount(),
      });
    },
  });

  // ── graph_recall_neighbours ───────────────────────────────────
  const recallNeighboursTool = weaveTool({
    name: 'graph_recall_neighbours',
    description:
      'Retrieve all entity nodes reachable from a given starting entity within N hops in the knowledge graph, along with their connecting edges. Useful for exploring relationships around a concept or person.',
    parameters: {
      type: 'object' as const,
      properties: {
        entityId: {
          type: 'string',
          description: 'ID of the starting entity node',
        },
        depth: {
          type: 'number',
          description: 'Maximum hop depth for traversal (default: 1, max: 3)',
        },
        relationshipType: {
          type: 'string',
          description: 'Optional: filter to only edges of this relationship type',
        },
      },
      required: ['entityId'],
    },
    tags: ['memory', 'graph', 'traversal'],
    execute: async (args) => {
      const { entityId, depth: rawDepth, relationshipType } = args as {
        entityId: string;
        depth?: number;
        relationshipType?: string;
      };

      const depth = Math.max(1, Math.min(3, Number(rawDepth ?? 1)));
      const root = store.getNode(entityId);

      if (!root) {
        return JSON.stringify({ ok: false, error: `Entity not found: ${entityId}` });
      }

      const neighbours = store.getNeighbors(entityId, depth);

      // Collect edges connecting root or neighbours
      const allNodeIds = new Set([entityId, ...neighbours.map((n) => n.id)]);
      const relevantEdges: Array<{ id: string; sourceId: string; targetId: string; type: string; weight: number }> = [];

      for (const nodeId of allNodeIds) {
        for (const edge of store.getEdgesFrom(nodeId)) {
          if (allNodeIds.has(edge.targetId)) {
            if (!relationshipType || edge.type === relationshipType) {
              if (!relevantEdges.find((e) => e.id === edge.id)) {
                relevantEdges.push({ id: edge.id, sourceId: edge.sourceId, targetId: edge.targetId, type: edge.type, weight: edge.weight });
              }
            }
          }
        }
      }

      const filteredNeighbours = relationshipType
        ? neighbours.filter((n) => relevantEdges.some((e) => e.sourceId === n.id || e.targetId === n.id))
        : neighbours;

      return JSON.stringify({
        ok: true,
        root: { id: root.id, type: root.type, name: root.name, properties: root.properties },
        depth,
        neighbourCount: filteredNeighbours.length,
        neighbours: filteredNeighbours.map((n) => ({
          id: n.id,
          type: n.type,
          name: n.name,
          properties: n.properties,
        })),
        edgeCount: relevantEdges.length,
        edges: relevantEdges,
      }, null, 2);
    },
  });

  return [entityAddTool, entitySearchTool, relateTool, recallNeighboursTool];
}

/**
 * Convenience wrapper: builds all 4 graph memory tools and returns them
 * pre-loaded into a `ToolRegistry`.
 */
export function createGraphMemoryToolRegistry(store: GraphMemoryStore): ToolRegistry {
  const reg = weaveToolRegistry();
  for (const tool of createGraphMemoryToolSet(store)) {
    reg.register(tool);
  }
  return reg;
}
