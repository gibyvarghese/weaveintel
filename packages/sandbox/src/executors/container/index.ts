/**
 * @weaveintel/sandbox — ContainerExecutor
 *
 * High-level executor that composes:
 *   - ImagePolicy  (allow-list by digest)
 *   - ContainerRuntime  (Docker / Podman / Fake)
 *   - ResultCache  (keyed by reproducibility hash)
 *   - Tracer  (from @weaveintel/observability / @weaveintel/core)
 *
 * Security guarantees:
 *   - Tags are rejected; only sha256 digests are accepted.
 *   - Env keys not on the image allow-list are stripped (not thrown).
 *   - spec.limits are validated against the image policy resourceCeiling.
 *   - Failures are never cached.
 */

import type { ExecutionContext, Tracer } from '@weaveintel/core';
import type { ImagePolicy } from './image-policy.js';
import type { ContainerRuntime, ContainerRunSpec, ContainerRunResult, ResultCache } from './types.js';
import { DigestRequired, ImageNotAllowed } from './errors.js';

export type { ContainerRuntime, ContainerRunSpec, ContainerRunResult, ResultCache, WarmSpec } from './types.js';
export type { ImagePolicy, ImagePolicyEntry, ImageResourceCeiling } from './image-policy.js';
export { createImagePolicy } from './image-policy.js';
export { DigestRequired, ImageNotAllowed, NetworkDenied, ResourceLimitExceeded, EnvKeyDenied } from './errors.js';
export { FakeRuntime, type FakeRuntimeOptions } from './fake-runtime.js';
export { DockerRuntime, type DockerRuntimeOptions } from './docker-runtime.js';

export interface ContainerExecutorOptions {
  runtime: ContainerRuntime;
  imagePolicy: ImagePolicy;
  cache?: ResultCache<ContainerRunResult>;
  tracer?: Tracer;
}

/**
 * Validates, filters, and delegates container execution.
 * Implements a simple `execute()` surface so agent tool wrappers
 * stay thin and do not need to know about policy/caching internals.
 */
export class ContainerExecutor {
  private readonly runtime: ContainerRuntime;
  private readonly policy: ImagePolicy;
  private readonly cache: ResultCache<ContainerRunResult> | undefined;
  private readonly tracer: Tracer | undefined;

  constructor(opts: ContainerExecutorOptions) {
    this.runtime = opts.runtime;
    this.policy = opts.imagePolicy;
    this.cache = opts.cache;
    this.tracer = opts.tracer;
  }

  async execute(spec: ContainerRunSpec, ctx?: ExecutionContext): Promise<ContainerRunResult> {
    // 1. Reject tags — only sha256 digests
    if (!spec.imageDigest.startsWith('sha256:')) {
      throw new DigestRequired(spec.imageDigest);
    }

    // 2. Image policy check
    const entry = this.policy.findByDigest(spec.imageDigest);
    if (!entry) {
      throw new ImageNotAllowed(spec.imageDigest);
    }

    // 3. Validate and clamp limits against policy ceiling
    const ceiling = entry.resourceCeiling;
    const limits = {
      cpuMillis: Math.min(spec.limits.cpuMillis, ceiling.cpuMillis),
      memoryMB: Math.min(spec.limits.memoryMB, ceiling.memoryMB),
      wallTimeSeconds: Math.min(spec.limits.wallTimeSeconds, ceiling.wallTimeSeconds),
      stdoutBytes: spec.limits.stdoutBytes,
      stderrBytes: spec.limits.stderrBytes,
    };

    // 4. Strip env keys not on allow-list (non-fatal — logged in span attrs)
    const rawEnv = spec.env ?? {};
    const filteredEnv: Record<string, string> = {};
    const strippedKeys: string[] = [];
    for (const [k, v] of Object.entries(rawEnv)) {
      if (entry.envAllowList.includes(k)) {
        filteredEnv[k] = v;
      } else {
        strippedKeys.push(k);
      }
    }

    // 5. Validate network request against policy
    const networkAllowList = spec.networkAllowList ?? [];
    const policyNetwork = entry.networkAllowList as string[];

    // 6. Cache check
    if (this.cache) {
      const cached = await this.cache.get(spec.reproducibilityHash);
      if (cached) {
        this._emitSpan(ctx, 'container.execute', { cache: 'hit', imageDigest: spec.imageDigest });
        return cached;
      }
    }

    // 7. Build filtered spec and run
    const filteredSpec: ContainerRunSpec = {
      ...spec,
      limits,
      env: Object.keys(filteredEnv).length > 0 ? filteredEnv : undefined,
      networkAllowList: networkAllowList.filter((h) => policyNetwork.includes(h)),
    };

    const spanAttrs: Record<string, unknown> = {
      cache: 'miss',
      imageDigest: spec.imageDigest,
      reproducibilityHash: spec.reproducibilityHash,
      strippedEnvKeys: strippedKeys,
    };

    const result = await this._withSpan(ctx, 'container.execute', spanAttrs, () =>
      this.runtime.run(filteredSpec),
    );

    // 8. Cache successful results only
    if (this.cache && result.exitCode === 0) {
      await this.cache.set(spec.reproducibilityHash, result);
    }

    return result;
  }

  private _emitSpan(ctx: ExecutionContext | undefined, name: string, attrs: Record<string, unknown>): void {
    if (!this.tracer || !ctx) return;
    const span = this.tracer.startSpan(ctx, name, attrs);
    span.end();
  }

  private async _withSpan<T>(
    ctx: ExecutionContext | undefined,
    name: string,
    attrs: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.tracer || !ctx) return fn();
    return this.tracer.withSpan(ctx, name, fn, attrs);
  }
}

/** Factory shorthand for constructing a ContainerExecutor. */
export function weaveContainerExecutor(opts: ContainerExecutorOptions): ContainerExecutor {
  return new ContainerExecutor(opts);
}
