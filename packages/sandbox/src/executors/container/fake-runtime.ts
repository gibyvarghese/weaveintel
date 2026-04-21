/**
 * @weaveintel/sandbox — FakeRuntime
 *
 * Deterministic in-memory ContainerRuntime for tests.
 * Keyed by (imageDigest, canonical stdin) → fixed ContainerRunResult.
 * No Docker or network access — safe to run in any environment.
 */

import { createHash } from 'node:crypto';
import type { ContainerRuntime, ContainerRunSpec, ContainerRunResult, WarmSpec } from './types.js';

/** Lookup key built from (imageDigest, canonical stdin). */
function buildKey(imageDigest: string, stdin: string): string {
  return createHash('sha256').update(imageDigest).update('\x00').update(stdin).digest('hex');
}

/** Options for FakeRuntime. */
export interface FakeRuntimeOptions {
  /**
   * Pre-seeded responses keyed by `${imageDigest}:${stdin}` key (use
   * `FakeRuntime.key(imageDigest, stdin)` to build the key consistently).
   */
  responses?: Map<string, ContainerRunResult>;
  /** Default result returned when no matching key is found. */
  defaultResult?: ContainerRunResult;
  /** Simulated wall time in ms (default: 1). */
  wallMs?: number;
}

/** Default success result used when no match is registered. */
const DEFAULT_RESULT: ContainerRunResult = {
  stdout: '{"result":"fake"}',
  stderr: '',
  exitCode: 0,
  wallMs: 1,
  cpuMs: 1,
  truncated: { stdout: false, stderr: false },
};

/**
 * Deterministic in-memory runtime for tests.
 *
 * Usage:
 * ```ts
 * const fake = new FakeRuntime({
 *   responses: new Map([
 *     [FakeRuntime.key('sha256:abc', '{"x":1}'), { stdout: '42', stderr: '', exitCode: 0, wallMs: 1, cpuMs: 1, truncated: { stdout: false, stderr: false } }],
 *   ]),
 * });
 * ```
 */
export class FakeRuntime implements ContainerRuntime {
  readonly name = 'fake' as const;

  private readonly responses: Map<string, ContainerRunResult>;
  private readonly defaultResult: ContainerRunResult;
  private readonly _wallMs: number;

  /** Calls recorded for assertion in tests. */
  readonly calls: Array<{ spec: ContainerRunSpec; result: ContainerRunResult }> = [];

  constructor(opts: FakeRuntimeOptions = {}) {
    this.responses = opts.responses ?? new Map();
    this.defaultResult = opts.defaultResult ?? DEFAULT_RESULT;
    this._wallMs = opts.wallMs ?? 1;
  }

  /** Build the lookup key used by FakeRuntime for a (digest, stdin) pair. */
  static key(imageDigest: string, stdin: string): string {
    return buildKey(imageDigest, stdin);
  }

  async run(spec: ContainerRunSpec): Promise<ContainerRunResult> {
    const key = buildKey(spec.imageDigest, spec.stdin);
    const result = this.responses.get(key) ?? { ...this.defaultResult, wallMs: this._wallMs };
    this.calls.push({ spec, result });
    return { ...result };
  }

  // warm() and shutdown() are optional; FakeRuntime is a no-op for both.

  /**
   * Register a canned result for a (digest, stdin) pair.
   * Returns `this` for chaining.
   */
  register(imageDigest: string, stdin: string, result: ContainerRunResult): this {
    this.responses.set(buildKey(imageDigest, stdin), result);
    return this;
  }

  /** Reset recorded call history (responses are preserved). */
  resetCalls(): void {
    this.calls.length = 0;
  }
}
