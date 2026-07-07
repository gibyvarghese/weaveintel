// SPDX-License-Identifier: MIT
/**
 * The shared HumanTaskRepository contract, run against the in-memory reference adapter (hermetic — no
 * Docker). This both proves the reference conforms AND pins the exact behaviour the Postgres adapter
 * must match (see repository-postgres.realsandbox.test.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryHumanTaskRepository } from '../repository.js';
import { humanTaskRepositoryContract } from '../repository-contract.js';

humanTaskRepositoryContract(() => new InMemoryHumanTaskRepository(), { describe, it, beforeEach, expect } as never);
