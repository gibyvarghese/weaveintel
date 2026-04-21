/**
 * @weaveintel/sandbox — Container executor test suite
 *
 * Tests cover all 8 categories from spec §4.5:
 *   1. Determinism
 *   2. Isolation (network)
 *   3. Resource limits (memory, wall-time)
 *   4. Policy (image not allowed)
 *   5. Cache interop
 *   6. Env allow-list
 *   7. Stdout cap
 *   8. Backwards compatibility (in-process executor unchanged)
 *
 * Docker integration tests are gated behind process.env.CI_DOCKER.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ContainerExecutor,
  weaveContainerExecutor,
  FakeRuntime,
  createImagePolicy,
  DigestRequired,
  ImageNotAllowed,
  type ContainerRunSpec,
  type ContainerRunResult,
  type ResultCache,
} from './index.js';
import { createSandbox } from '../../sandbox.js';
import { createSandboxPolicy } from '../../policy.js';

// ─── Helpers ─────────────────────────────────────────────────

const DIGEST_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DIGEST_B = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const STDIN_1 = '{"x":1}';
const STDIN_2 = '{"x":2}';

function buildPolicy(digest: string, opts?: {
  networkAllowList?: string[];
  envAllowList?: string[];
  cpuMillis?: number;
  memoryMB?: number;
  wallTimeSeconds?: number;
}) {
  return createImagePolicy([{
    digest,
    description: 'test image',
    networkAllowList: opts?.networkAllowList ?? [],
    envAllowList: opts?.envAllowList ?? ['SAFE_KEY'],
    resourceCeiling: {
      cpuMillis: opts?.cpuMillis ?? 2000,
      memoryMB: opts?.memoryMB ?? 512,
      wallTimeSeconds: opts?.wallTimeSeconds ?? 30,
    },
  }]);
}

function buildSpec(overrides?: Partial<ContainerRunSpec>): ContainerRunSpec {
  return {
    imageDigest: DIGEST_A,
    stdin: STDIN_1,
    limits: {
      cpuMillis: 1000,
      memoryMB: 256,
      wallTimeSeconds: 10,
      stdoutBytes: 1024 * 1024,
      stderrBytes: 64 * 1024,
    },
    reproducibilityHash: 'hash-001',
    ...overrides,
  };
}

function buildResult(stdout = '{"result":"ok"}', exitCode = 0): ContainerRunResult {
  return { stdout, stderr: '', exitCode, wallMs: 1, cpuMs: 1, truncated: { stdout: false, stderr: false } };
}

function buildInMemoryCache(): ResultCache<ContainerRunResult> & { store: Map<string, ContainerRunResult> } {
  const store = new Map<string, ContainerRunResult>();
  return {
    store,
    async get(key: string): Promise<ContainerRunResult | null> { return store.get(key) ?? null; },
    async set(key: string, value: ContainerRunResult): Promise<void> { store.set(key, value); },
  };
}

// ─── 1. Determinism ──────────────────────────────────────────

describe('1. Determinism', () => {
  it('returns identical result for identical (digest, stdin) across 10 invocations', async () => {
    const fake = new FakeRuntime({
      responses: new Map([[FakeRuntime.key(DIGEST_A, STDIN_1), buildResult('{"value":42}')]]),
    });
    const executor = new ContainerExecutor({ runtime: fake, imagePolicy: buildPolicy(DIGEST_A) });
    const spec = buildSpec();

    const results = await Promise.all(Array.from({ length: 10 }, () => executor.execute(spec)));

    const first = results[0]!;
    for (const r of results) {
      expect(r.stdout).toBe(first.stdout);
      expect(r.exitCode).toBe(first.exitCode);
    }
  });

  it('returns different results for different stdin values', async () => {
    const fake = new FakeRuntime({
      responses: new Map([
        [FakeRuntime.key(DIGEST_A, STDIN_1), buildResult('{"value":1}')],
        [FakeRuntime.key(DIGEST_A, STDIN_2), buildResult('{"value":2}')],
      ]),
    });
    const executor = new ContainerExecutor({ runtime: fake, imagePolicy: buildPolicy(DIGEST_A) });

    const r1 = await executor.execute(buildSpec({ stdin: STDIN_1, reproducibilityHash: 'h1' }));
    const r2 = await executor.execute(buildSpec({ stdin: STDIN_2, reproducibilityHash: 'h2' }));
    expect(r1.stdout).toBe('{"value":1}');
    expect(r2.stdout).toBe('{"value":2}');
  });
});

// ─── 2. Isolation (network) ───────────────────────────────────

describe('2. Isolation (network allow-list)', () => {
  it('strips network request when image policy has no networkAllowList', async () => {
    const fake = new FakeRuntime();
    const executor = new ContainerExecutor({ runtime: fake, imagePolicy: buildPolicy(DIGEST_A, { networkAllowList: [] }) });
    const spec = buildSpec({ networkAllowList: ['evil.example.com'] });

    await executor.execute(spec);

    // The filtered spec passed to the runtime should have the host stripped
    expect(fake.calls[0]!.spec.networkAllowList).toEqual([]);
  });

  it('passes allowed host through when image policy permits it', async () => {
    const fake = new FakeRuntime();
    const executor = new ContainerExecutor({
      runtime: fake,
      imagePolicy: buildPolicy(DIGEST_A, { networkAllowList: ['arxiv.org'] }),
    });
    const spec = buildSpec({ networkAllowList: ['arxiv.org'] });

    await executor.execute(spec);

    expect(fake.calls[0]!.spec.networkAllowList).toContain('arxiv.org');
  });
});

// ─── 3. Resource limits ───────────────────────────────────────

describe('3. Resource limits', () => {
  it('clamps cpuMillis to image policy ceiling', async () => {
    const fake = new FakeRuntime();
    const executor = new ContainerExecutor({
      runtime: fake,
      imagePolicy: buildPolicy(DIGEST_A, { cpuMillis: 500 }),
    });
    // Request 2000ms cpu — ceiling is 500
    await executor.execute(buildSpec({ limits: { cpuMillis: 2000, memoryMB: 256, wallTimeSeconds: 10, stdoutBytes: 1e6, stderrBytes: 64000 } }));
    expect(fake.calls[0]!.spec.limits.cpuMillis).toBe(500);
  });

  it('clamps memoryMB to image policy ceiling', async () => {
    const fake = new FakeRuntime();
    const executor = new ContainerExecutor({
      runtime: fake,
      imagePolicy: buildPolicy(DIGEST_A, { memoryMB: 128 }),
    });
    await executor.execute(buildSpec({ limits: { cpuMillis: 1000, memoryMB: 4096, wallTimeSeconds: 10, stdoutBytes: 1e6, stderrBytes: 64000 } }));
    expect(fake.calls[0]!.spec.limits.memoryMB).toBe(128);
  });

  it('clamps wallTimeSeconds to image policy ceiling', async () => {
    const fake = new FakeRuntime();
    const executor = new ContainerExecutor({
      runtime: fake,
      imagePolicy: buildPolicy(DIGEST_A, { wallTimeSeconds: 5 }),
    });
    await executor.execute(buildSpec({ limits: { cpuMillis: 1000, memoryMB: 256, wallTimeSeconds: 999, stdoutBytes: 1e6, stderrBytes: 64000 } }));
    expect(fake.calls[0]!.spec.limits.wallTimeSeconds).toBe(5);
  });
});

// ─── 4. Policy (image not allowed) ───────────────────────────

describe('4. Image policy enforcement', () => {
  it('throws DigestRequired for a tag (non-sha256 digest)', async () => {
    const fake = new FakeRuntime();
    const executor = new ContainerExecutor({ runtime: fake, imagePolicy: buildPolicy(DIGEST_A) });
    const spec = buildSpec({ imageDigest: 'python:3.12-slim' });
    await expect(executor.execute(spec)).rejects.toThrow(DigestRequired);
  });

  it('throws ImageNotAllowed when digest is not in policy', async () => {
    const fake = new FakeRuntime();
    // Policy only allows DIGEST_A
    const executor = new ContainerExecutor({ runtime: fake, imagePolicy: buildPolicy(DIGEST_A) });
    const spec = buildSpec({ imageDigest: DIGEST_B });
    await expect(executor.execute(spec)).rejects.toThrow(ImageNotAllowed);
  });

  it('proceeds when digest is in policy', async () => {
    const fake = new FakeRuntime({ defaultResult: buildResult('ok') });
    const executor = new ContainerExecutor({ runtime: fake, imagePolicy: buildPolicy(DIGEST_A) });
    const result = await executor.execute(buildSpec());
    expect(result.stdout).toBe('ok');
  });
});

// ─── 5. Cache interop ────────────────────────────────────────

describe('5. Cache interop', () => {
  it('returns cached result on second invocation with same hash', async () => {
    const fake = new FakeRuntime({ defaultResult: buildResult('fresh') });
    const cache = buildInMemoryCache();
    const executor = new ContainerExecutor({ runtime: fake, imagePolicy: buildPolicy(DIGEST_A), cache });

    const spec = buildSpec({ reproducibilityHash: 'stable-hash' });

    const r1 = await executor.execute(spec);
    expect(r1.stdout).toBe('fresh');
    expect(fake.calls).toHaveLength(1);

    // Second call — should come from cache, runtime not called again
    fake.resetCalls();
    const r2 = await executor.execute(spec);
    expect(r2.stdout).toBe('fresh');
    expect(fake.calls).toHaveLength(0); // cache hit, no runtime call
  });

  it('does not cache failed (non-zero exit) results', async () => {
    const failed = { ...buildResult('', 1) };
    const fake = new FakeRuntime({ defaultResult: failed });
    const cache = buildInMemoryCache();
    const executor = new ContainerExecutor({ runtime: fake, imagePolicy: buildPolicy(DIGEST_A), cache });

    const spec = buildSpec({ reproducibilityHash: 'fail-hash' });

    await executor.execute(spec);
    expect(cache.store.has('fail-hash')).toBe(false);
  });

  it('stores successful result in cache', async () => {
    const fake = new FakeRuntime({ defaultResult: buildResult('{"x":1}') });
    const cache = buildInMemoryCache();
    const executor = new ContainerExecutor({ runtime: fake, imagePolicy: buildPolicy(DIGEST_A), cache });

    await executor.execute(buildSpec({ reproducibilityHash: 'ok-hash' }));
    expect(cache.store.has('ok-hash')).toBe(true);
  });
});

// ─── 6. Env allow-list ───────────────────────────────────────

describe('6. Env allow-list', () => {
  it('passes allow-listed env keys to runtime', async () => {
    const fake = new FakeRuntime();
    // Policy allows SAFE_KEY
    const executor = new ContainerExecutor({ runtime: fake, imagePolicy: buildPolicy(DIGEST_A, { envAllowList: ['SAFE_KEY'] }) });
    await executor.execute(buildSpec({ env: { SAFE_KEY: 'hello' } }));
    expect(fake.calls[0]!.spec.env).toEqual({ SAFE_KEY: 'hello' });
  });

  it('strips unlisted env keys silently', async () => {
    const fake = new FakeRuntime();
    const executor = new ContainerExecutor({ runtime: fake, imagePolicy: buildPolicy(DIGEST_A, { envAllowList: ['SAFE_KEY'] }) });
    await executor.execute(buildSpec({ env: { SAFE_KEY: 'hello', EVIL_KEY: 'bad' } }));
    expect(fake.calls[0]!.spec.env).toEqual({ SAFE_KEY: 'hello' });
  });

  it('passes no env object when all keys are stripped', async () => {
    const fake = new FakeRuntime();
    const executor = new ContainerExecutor({ runtime: fake, imagePolicy: buildPolicy(DIGEST_A, { envAllowList: [] }) });
    await executor.execute(buildSpec({ env: { EVIL_KEY: 'bad' } }));
    expect(fake.calls[0]!.spec.env).toBeUndefined();
  });
});

// ─── 7. Stdout cap ───────────────────────────────────────────

describe('7. Stdout / stderr cap (via FakeRuntime truncation flag)', () => {
  it('returns truncated.stdout=true when runtime reports truncation', async () => {
    const truncatedResult: ContainerRunResult = {
      stdout: 'a'.repeat(100),
      stderr: '',
      exitCode: 0,
      wallMs: 1,
      cpuMs: 1,
      truncated: { stdout: true, stderr: false },
    };
    const fake = new FakeRuntime({ defaultResult: truncatedResult });
    const executor = new ContainerExecutor({ runtime: fake, imagePolicy: buildPolicy(DIGEST_A) });
    const result = await executor.execute(buildSpec());
    expect(result.truncated.stdout).toBe(true);
  });
});

// ─── 8. Backwards compatibility ──────────────────────────────

describe('8. Backwards compatibility — in-process executor unchanged', () => {
  it('createSandbox() still executes code without error', async () => {
    const sandbox = createSandbox();
    const policy = createSandboxPolicy({ name: 'compat-test' });
    const result = await sandbox.execute('const x = 1 + 1;', policy);
    expect(result.status).toBe('success');
  });

  it('createSandbox() terminate() resolves cleanly for unknown id', async () => {
    const sandbox = createSandbox();
    await expect(sandbox.terminate('nonexistent-id')).resolves.toBeUndefined();
  });
});

// ─── Factory function ─────────────────────────────────────────

describe('weaveContainerExecutor factory', () => {
  it('creates a ContainerExecutor instance', () => {
    const fake = new FakeRuntime();
    const executor = weaveContainerExecutor({ runtime: fake, imagePolicy: buildPolicy(DIGEST_A) });
    expect(executor).toBeInstanceOf(ContainerExecutor);
  });
});
