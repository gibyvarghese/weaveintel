/**
 * @weaveintel/sandbox — Container runtime shared types
 *
 * These interfaces are stable public API. Runtime adapters (Docker, Podman, Fake)
 * implement ContainerRuntime. ContainerExecutor consumes it.
 */

/** Spec for a single container invocation. */
export interface ContainerRunSpec {
  /** sha256:... digest — tags are rejected by ContainerExecutor. */
  imageDigest: string;
  /** Command override. If omitted the image CMD is used. */
  command?: string[];
  /** JSON-serialisable payload written to the container's stdin. */
  stdin: string;
  /** Allow-listed environment variable overrides. Keys not in ImagePolicy.envAllowList are stripped. */
  env?: Record<string, string>;
  /** Host names the container may reach. Empty = no network. Overrides are validated against ImagePolicy. */
  networkAllowList?: string[];
  /** Resource limits. Executor validates against ImagePolicy resourceCeiling. */
  limits: {
    cpuMillis: number;
    memoryMB: number;
    wallTimeSeconds: number;
    /** Stdout is truncated and flagged when this byte count is exceeded. */
    stdoutBytes: number;
    /** Stderr is truncated and flagged when this byte count is exceeded. */
    stderrBytes: number;
  };
  /** Caller-computed sha256 over (imageDigest, canonical JSON stdin, executor version). */
  reproducibilityHash: string;
}

/** Result returned by a ContainerRuntime run. */
export interface ContainerRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Elapsed real time in milliseconds. */
  wallMs: number;
  /** CPU time consumed in milliseconds (best-effort from runtime stats). */
  cpuMs: number;
  /** Whether output was truncated due to byte caps. */
  truncated: { stdout: boolean; stderr: boolean };
}

/** Spec for optional runtime pre-warming (e.g. docker pull). */
export interface WarmSpec {
  imageDigest: string;
}

/** Low-level container runtime adapter. */
export interface ContainerRuntime {
  readonly name: 'docker' | 'podman' | 'fake';
  run(spec: ContainerRunSpec): Promise<ContainerRunResult>;
  /** Optional — pre-pull the image so first run is faster. */
  warm?(spec: WarmSpec): Promise<void>;
  /** Optional — clean up connections or processes on shutdown. */
  shutdown?(): Promise<void>;
}

/** Simple key-value result cache used by ContainerExecutor to skip redundant runs. */
export interface ResultCache<T> {
  get(key: string): Promise<T | null>;
  set(key: string, value: T): Promise<void>;
}
