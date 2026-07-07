// SPDX-License-Identifier: MIT
/**
 * Hermetic proof (no Docker) that the ONE Drizzle memory implementation passes the shared contract on
 * SQLite. Postgres runs the same contract on a real database in drizzle-memory.realsandbox.test.ts.
 * Each test gets a fresh in-memory database, so runs are isolated.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { weaveSqliteMemoryStore } from './memory-sqlite.js';
import { memoryStoreContract } from './memory-store-contract.js';

describe('Drizzle → SQLite', () => {
  memoryStoreContract(() => weaveSqliteMemoryStore({ path: ':memory:' }), { describe, it, beforeEach, expect } as never);
});
