// SPDX-License-Identifier: MIT
/**
 * Hermetic proof (no Docker) that the ONE Drizzle trigger implementation behaves identically to the
 * in-memory reference — run the SAME shared contract against both. Postgres runs on a real database in
 * drizzle-trigger-store.realsandbox.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryTriggerStore } from './dispatcher.js';
import { weaveSqliteTriggerStore } from './sqlite-trigger-store.js';
import { triggerStoreContract } from './trigger-store-contract.js';

describe('reference: InMemoryTriggerStore', () => {
  triggerStoreContract(() => new InMemoryTriggerStore(), { describe, it, beforeEach, expect } as never);
});

describe('Drizzle → SQLite', () => {
  triggerStoreContract(() => weaveSqliteTriggerStore(), { describe, it, beforeEach, expect } as never);
});
