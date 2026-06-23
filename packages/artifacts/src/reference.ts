import type { Artifact, ArtifactReference, ArtifactStore } from '@weaveintel/core';

/**
 * Create an ArtifactReference.
 */
export function createArtifactReference(
  artifactId: string,
  version?: number,
  label?: string,
): ArtifactReference {
  return { artifactId, version, label };
}

/**
 * Resolve a reference to the actual Artifact. If the reference includes a
 * specific version, the returned artifact is patched with that version's data.
 *
 * Throws when:
 *  - The artifact does not exist
 *  - A specific version is requested but that version record does not exist
 *    (avoids silently returning the latest data for a pinned reference)
 */
export async function resolveReference(
  store: ArtifactStore,
  ref: ArtifactReference,
): Promise<Artifact> {
  const artifact = await store.get(ref.artifactId);
  if (!artifact) {
    throw new Error(`Artifact not found: ${ref.artifactId}`);
  }

  if (ref.version !== undefined) {
    const versionRecords = await store.getVersions(ref.artifactId);
    const match = versionRecords.find((v) => v.version === ref.version);
    if (!match) {
      throw new Error(
        `Artifact ${ref.artifactId} version ${ref.version} not found ` +
        `(available: ${versionRecords.map((v) => v.version).join(', ') || 'none'})`,
      );
    }
    return { ...artifact, data: match.data, version: match.version };
  }

  return artifact;
}

/**
 * Resolve a reference, returning null instead of throwing when not found.
 * Useful for optional references where absence is a valid state.
 */
export async function tryResolveReference(
  store: ArtifactStore,
  ref: ArtifactReference,
): Promise<Artifact | null> {
  try {
    return await resolveReference(store, ref);
  } catch {
    return null;
  }
}

/**
 * Format a reference as a human-readable string.
 */
export function formatReference(ref: ArtifactReference): string {
  let out = `artifact:${ref.artifactId}`;
  if (ref.version !== undefined) {
    out += `@v${ref.version}`;
  }
  if (ref.label) {
    out += ` (${ref.label})`;
  }
  return out;
}
