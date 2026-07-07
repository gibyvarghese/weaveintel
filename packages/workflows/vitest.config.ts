// SPDX-License-Identifier: MIT
import { defineConfig } from 'vitest/config';

// Two suites in this package each spin up their own throwaway Postgres via Testcontainers
// (drizzle-workflow-stores.realsandbox + drizzle-checkpoint.realsandbox). With vitest's default
// file-level parallelism, both containers are alive at once, which under CI's constrained Docker can
// get one reaped mid-query — surfacing as Postgres 57P01 ("terminating connection due to
// administrator command") and failing the run even though every assertion passed.
//
// Running the test files serially keeps at most one container alive at a time, which removes the
// resource contention. Files still get vitest's default module isolation; only their concurrency
// changes. (The non-container unit suites are fast, so the serial cost is negligible.)
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
