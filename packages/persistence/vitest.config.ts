// SPDX-License-Identifier: MIT
import { defineConfig } from 'vitest/config';

// Three suites in this package each spin up their own throwaway Postgres via Testcontainers
// (postgres-slot, kv-cutover.realsandbox, shared-postgres-coexistence.realsandbox). With vitest's
// default file-level parallelism all three containers are alive at once, and the KV-cutover suite's
// 50k-key stress can push a small CI runner into memory pressure. Running the files serially keeps
// at most one container alive at a time. Files keep vitest's default module isolation; only their
// concurrency changes.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
