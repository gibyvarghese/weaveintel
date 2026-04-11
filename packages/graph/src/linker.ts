// @weaveintel/graph — Document-to-entity linker

import { createEntityNode, createRelationshipEdge, type EntityNode, type RelationshipEdge } from './entity.js';

export interface LinkResult {
  readonly entities: readonly EntityNode[];
  readonly relationships: readonly RelationshipEdge[];
}

export interface EntityLinker {
  extractAndLink(documentId: string, text: string, existingEntities?: readonly EntityNode[]): LinkResult;
}

export function createEntityLinker(): EntityLinker {
  return {
    extractAndLink(documentId, text, existingEntities = []) {
      const entities: EntityNode[] = [];
      const relationships: RelationshipEdge[] = [];

      // Simple pattern-based entity extraction
      const patterns: Array<{ regex: RegExp; type: string }> = [
        { regex: /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g, type: 'person' },
        { regex: /\b(?:https?:\/\/[^\s]+)\b/g, type: 'url' },
        { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, type: 'email' },
        { regex: /\b\d{4}-\d{2}-\d{2}\b/g, type: 'date' },
      ];

      const seen = new Set<string>();

      for (const { regex, type } of patterns) {
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          const name = match[0];
          const key = `${type}:${name.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);

          // Check if entity already exists
          const existing = existingEntities.find(
            (e) => e.type === type && e.name.toLowerCase() === name.toLowerCase(),
          );

          const entity = existing ?? createEntityNode(`ent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, type, name);
          if (!existing) entities.push(entity);

          // Link document to entity
          relationships.push(createRelationshipEdge(documentId, entity.id, 'mentions'));
        }
      }

      return { entities, relationships };
    },
  };
}
