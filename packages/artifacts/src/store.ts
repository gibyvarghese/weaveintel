import { newUUIDv7 } from '@weaveintel/core';
import type { Artifact, ArtifactStore, ArtifactListFilter, ArtifactType, ArtifactVersion } from '@weaveintel/core';
import type { ArtifactPolicy } from '@weaveintel/core';
import { createArtifactVersion, estimateSize } from './artifact.js';
import { validateArtifact } from './policy.js';

export interface InMemoryArtifactStoreOptions {
  /** When provided, every save() call validates against this policy and throws on violation. */
  policy?: ArtifactPolicy;
}

/**
 * Create an in-memory implementation of ArtifactStore.
 * Suitable for testing and short-lived processes. Not persistent across restarts.
 */
export function createInMemoryArtifactStore(opts?: InMemoryArtifactStoreOptions): ArtifactStore {
  const artifacts = new Map<string, Artifact>();
  const versions = new Map<string, ArtifactVersion[]>();

  function enforcePolicy(artifact: Artifact): void {
    if (!opts?.policy) return;
    const result = validateArtifact(artifact, opts.policy);
    if (!result.valid) {
      throw new Error(`ArtifactStore policy violation: ${result.violations.join('; ')}`);
    }
  }

  const store: ArtifactStore = {
    async save(input) {
      const id = newUUIDv7();
      const now = new Date().toISOString();
      const artifact: Artifact = {
        ...input,
        id,
        createdAt: now,
        sizeBytes: input.sizeBytes ?? estimateSize(input.data),
        scope: input.scope ?? 'session',
      };
      enforcePolicy(artifact);
      artifacts.set(id, artifact);
      const ver = createArtifactVersion(id, artifact.version, artifact.data);
      versions.set(id, [ver]);
      return artifact;
    },

    async update(artifactId, patch, changelog) {
      const existing = artifacts.get(artifactId);
      if (!existing) throw new Error(`Artifact not found: ${artifactId}`);
      const now = new Date().toISOString();
      const nextVersion = existing.version + 1;
      const updated: Artifact = {
        ...existing,
        ...patch,
        id: existing.id,         // id is immutable
        createdAt: existing.createdAt,
        version: nextVersion,
        updatedAt: now,
        sizeBytes: patch.data !== undefined
          ? estimateSize(patch.data)
          : existing.sizeBytes,
      };
      enforcePolicy(updated);
      artifacts.set(artifactId, updated);
      const prevVersions = versions.get(artifactId) ?? [];
      const newVer = createArtifactVersion(artifactId, nextVersion, updated.data, changelog);
      versions.set(artifactId, [...prevVersions, newVer]);
      return updated;
    },

    async get(artifactId) {
      return artifacts.get(artifactId) ?? null;
    },

    async list(filter?: ArtifactListFilter) {
      let results = Array.from(artifacts.values());

      if (filter?.type) {
        const types: ArtifactType[] = Array.isArray(filter.type) ? filter.type : [filter.type];
        results = results.filter((a) => types.includes(a.type));
      }
      if (filter?.runId) {
        const r = filter.runId;
        results = results.filter((a) => a.runId === r);
      }
      if (filter?.agentId) {
        const ag = filter.agentId;
        results = results.filter((a) => a.agentId === ag);
      }
      if (filter?.sessionId) {
        const s = filter.sessionId;
        results = results.filter((a) => a.sessionId === s);
      }
      if (filter?.userId) {
        const u = filter.userId;
        results = results.filter((a) => a.userId === u);
      }
      if (filter?.scope) {
        const sc = filter.scope;
        results = results.filter((a) => (a.scope ?? 'session') === sc);
      }
      if (filter?.tags && filter.tags.length > 0) {
        const required = filter.tags;
        results = results.filter((a) => {
          if (!a.tags) return false;
          return required.every((t: string) => a.tags!.includes(t));
        });
      }

      const offset = filter?.offset ?? 0;
      const limit = filter?.limit;
      if (offset > 0) results = results.slice(offset);
      if (limit !== undefined) results = results.slice(0, limit);

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
