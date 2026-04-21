/**
 * @weaveintel/sandbox — Container executor typed errors
 */

/** Thrown when a container attempts network egress outside its allow-list. */
export class NetworkDenied extends Error {
  readonly code = 'NETWORK_DENIED' as const;
  constructor(public readonly imageDigest: string, public readonly host: string) {
    super(`Network access denied: image ${imageDigest} is not allowed to reach ${host}`);
    this.name = 'NetworkDenied';
  }
}

/** Thrown when a container breaches a resource limit (memory, wall-time, cpu). */
export class ResourceLimitExceeded extends Error {
  readonly code = 'RESOURCE_LIMIT_EXCEEDED' as const;
  constructor(
    public readonly resource: 'memory' | 'wall_time' | 'cpu' | 'pids',
    public readonly limit: number,
    public readonly unit: string,
  ) {
    super(`Resource limit exceeded: ${resource} exceeded ${limit} ${unit}`);
    this.name = 'ResourceLimitExceeded';
  }
}

/** Thrown when a caller requests an image whose digest is not in the ImagePolicy. */
export class ImageNotAllowed extends Error {
  readonly code = 'IMAGE_NOT_ALLOWED' as const;
  constructor(public readonly imageDigest: string) {
    super(`Image not allowed by policy: ${imageDigest}`);
    this.name = 'ImageNotAllowed';
  }
}

/** Thrown when a tag (not a sha256 digest) is passed as imageDigest. */
export class DigestRequired extends Error {
  readonly code = 'DIGEST_REQUIRED' as const;
  constructor(public readonly value: string) {
    super(`Image digest must start with "sha256:" — got: ${value}`);
    this.name = 'DigestRequired';
  }
}

/** Thrown when a caller passes an env key that is not on the image allow-list. */
export class EnvKeyDenied extends Error {
  readonly code = 'ENV_KEY_DENIED' as const;
  constructor(public readonly key: string, public readonly imageDigest: string) {
    super(`Environment key "${key}" is not allowed for image ${imageDigest}`);
    this.name = 'EnvKeyDenied';
  }
}
