// SPDX-License-Identifier: MIT
/**
 * The one dialect seam for the Drizzle-backed trigger store.
 *
 * Drizzle's query builder reads the same across databases, so the store logic is written once. The
 * single real difference between the two SQL drivers is HOW a built query runs: node-postgres executes
 * when you `await` the builder, while better-sqlite3 is synchronous and executes on `.all()` / `.run()`.
 * These tiny adapters hide that difference so the store never has to care which database it's on.
 */

/** Runs a Drizzle query built against either driver. `all` returns rows; `run` just executes. */
export interface DrizzleExec {
  all<T = Record<string, unknown>>(builder: unknown): Promise<T[]>;
  run(builder: unknown): Promise<void>;
}

/** node-postgres: the query builder is a thenable — awaiting it runs the query. */
export const pgExec: DrizzleExec = {
  all: <T>(builder: unknown) => builder as Promise<T[]>,
  run: (builder) => (builder as Promise<unknown>).then(() => undefined),
};

/** better-sqlite3: synchronous — `.all()` returns rows, `.run()` executes. Wrapped to look async. */
export const sqliteExec: DrizzleExec = {
  all: <T>(builder: unknown) => Promise.resolve((builder as { all(): T[] }).all()),
  run: (builder) => { (builder as { run(): unknown }).run(); return Promise.resolve(); },
};
