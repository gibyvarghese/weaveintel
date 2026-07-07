// SPDX-License-Identifier: MIT
/**
 * The one dialect seam for the Drizzle-backed memory store. Drizzle's query builder reads the same
 * across databases, so the store logic is written once; the only real difference is that node-postgres
 * runs a query on `await` while better-sqlite3 is synchronous (`.all()` / `.run()`). These tiny adapters
 * hide that so the store never has to care which database it's on.
 */

export interface DrizzleExec {
  all<T = Record<string, unknown>>(builder: unknown): Promise<T[]>;
  run(builder: unknown): Promise<void>;
}

export const pgExec: DrizzleExec = {
  all: <T>(builder: unknown) => builder as Promise<T[]>,
  run: (builder) => (builder as Promise<unknown>).then(() => undefined),
};

export const sqliteExec: DrizzleExec = {
  all: <T>(builder: unknown) => Promise.resolve((builder as { all(): T[] }).all()),
  run: (builder) => { (builder as { run(): unknown }).run(); return Promise.resolve(); },
};

/** A strictly-increasing ISO clock so `updated_at` never ties → stable ordering on any database. */
export function monotonicIso(): () => string {
  let last = 0;
  return () => { const t = Math.max(Date.now(), last + 1); last = t; return new Date(t).toISOString(); };
}
