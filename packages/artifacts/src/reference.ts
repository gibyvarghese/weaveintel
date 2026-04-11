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
 */
export async function resolveReference(
  store: ArtifactStore,
  ref: ArtifactReference,
): Promise<Artifact | null> {
  const artifact = await store.get(ref.artifactId);
  if (!artifact) return null;

  if (ref.version !== undefined) {
    const versions = await store.getVersions(ref.artifactId);
    const match = versions.find((v) => v.version === ref.version);
    if (match) {
      return { ...artifact, data: match.data, version: match.version };
    }
  }

  return artifact;
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
