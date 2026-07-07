// SPDX-License-Identifier: MIT
import { defineConfig } from 'vitest/config';

// This package has latency-sensitive suites: retrieval.test measures a p95 over 1,000 retrievals,
// and the benchmark scores a p95 latency metric. Running test files in parallel on a 2-core CI
// runner lets the heavy benchmark/security-scan suites steal CPU from those measurements, inflating
// the tail past its target (a flake, not a regression). Running the files serially gives each suite
// the whole runner so the latency numbers are meaningful. Files keep vitest's default module
// isolation; only their concurrency changes.
export default defineConfig({
  test: {
    fileParallelism: false,
    // The scale/stress suites (5k-skill catalogs, 1k-retrieval loops, real-embedding benchmarks) are
    // comfortably sub-second on a dev box but can crawl on a shared 2-core CI runner. Raise the
    // default per-test budget above vitest's 5s so a slow runner never times out a passing test.
    testTimeout: 30_000,
  },
});
