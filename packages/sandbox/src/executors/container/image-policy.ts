/**
 * @weaveintel/sandbox — Image allow-list policy
 *
 * Images must be pinned by sha256 digest. Tags are rejected.
 * Each image entry declares the network hosts it may reach,
 * the allowed environment variable keys, and a resource ceiling.
 */

/** Resource ceiling for a single image entry. */
export interface ImageResourceCeiling {
  cpuMillis: number;
  memoryMB: number;
  wallTimeSeconds: number;
}

/** One row in the image allow-list. */
export interface ImagePolicyEntry {
  /** sha256:... digest — tags are not accepted. */
  readonly digest: string;
  /** Human description shown in logs and admin UIs. */
  readonly description: string;
  /**
   * Hosts the container may contact. Empty array means no network.
   * Values are exact hostnames (no wildcards in v1).
   */
  readonly networkAllowList: readonly string[];
  /** Hard ceiling; executor rejects spec values above these. */
  readonly resourceCeiling: ImageResourceCeiling;
  /** Environment variable keys the caller is permitted to pass. All others are stripped. */
  readonly envAllowList: readonly string[];
}

/** Image allow-list. Used by ContainerExecutor to gate every run. */
export interface ImagePolicy {
  /** Registered entries indexed by digest. */
  readonly entries: readonly ImagePolicyEntry[];
  /** Returns the entry for a digest, or null if not in the policy. */
  findByDigest(digest: string): ImagePolicyEntry | null;
}

/** Build an ImagePolicy from an array of entries. */
export function createImagePolicy(entries: ImagePolicyEntry[]): ImagePolicy {
  // Index for O(1) lookup
  const byDigest = new Map<string, ImagePolicyEntry>(entries.map((e) => [e.digest, e]));

  return {
    entries,
    findByDigest(digest: string): ImagePolicyEntry | null {
      return byDigest.get(digest) ?? null;
    },
  };
}
