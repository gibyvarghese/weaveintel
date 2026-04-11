import { randomUUID } from 'node:crypto';
import type { Artifact, ArtifactStore, ArtifactType, ArtifactVersion } from '@weaveintel/core';
import { createArtifactVersion, estimateSize } from './artifact.js';

/**
 * Create an in-memory implementation of ArtifactStore.
 */
export function createInMemoryArtifactStore(): ArtifactStore {
  const artifacts = new Map<string, Artifact>();
  const versions = new Map<string, ArtifactVersion[]>();

  const store: ArtifactStore = {
    async save(input) {
      const id = randomUUID();
      const now = new Date().toISOString();
      const artifact: Artifact = {
        ...input,
        id,
        createdAt: now,
        sizeBytes: input.sizeBytes ?? estimateSize(input.data),
      };
      artifacts.set(id, artifact);

      // Auto-create the first version entry
      const ver = createArtifactVersion(id, artifact.version, artifact.data);
      versions.set(id, [ver]);

      return artifact;
    },

    async get(artifactId) {
      return artifacts.get(artifactId) ?? null;
    },

    async list(filter) {
      let results = Array.from(artifacts.values());

      if (filter?.type) {
        const t: ArtifactType = filter.type;
        results = results.filter((a) => a.type === t);
      }
      if (filter?.runId) {
        const r = filter.runId;
        results = results.filter((a) => a.runId === r);
      }
      if (filter?.agentId) {
        const ag = filter.agentId;
        results = results.filter((a) => a.agentId === ag);
      }
      if (filter?.tags && filter.tags.length > 0) {
        const required = filter.tags;
        results = results.filter((a) => {
          if (!a.tags) return false;
          return required.every((t) => a.tags!.includes(t));
        });
      }

      return results;
    },

    async delete(artifactId) {
      artifacts.delete(artifactId);
      versions.delete(artifactId);
    },

    async getVersions(artifactId) {
      return versions.get(artifactId) ?? [];
    },
  };

  return store;
}
