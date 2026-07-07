// SPDX-License-Identifier: MIT
/**
 * Hermetic proof (no Docker) that the ONE Drizzle checkpoint implementation behaves identically to the
 * reference in-memory store — run the SAME shared contract against both. The Postgres side runs on a
 * real database in drizzle-checkpoint.realsandbox.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryCheckpointStore } from './checkpoint-store.js';
import { weaveSqliteCheckpointStore } from './sqlite-checkpoint-store.js';
import { checkpointStoreContract } from './checkpoint-store-contract.js';

// The reference implementation — proves the contract itself is faithful.
describe('reference: InMemoryCheckpointStore', () => {
  checkpointStoreContract(() => new InMemoryCheckpointStore(), { describe, it, beforeEach, expect } as never);
});

// The Drizzle-backed SQLite adapter — same contract, must pass identically.
describe('Drizzle → SQLite', () => {
  checkpointStoreContract(() => weaveSqliteCheckpointStore(), { describe, it, beforeEach, expect } as never);
});
