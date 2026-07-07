// SPDX-License-Identifier: MIT
/**
 * The one dialect seam shared by every Drizzle-backed workflow store (Phase 4).
 *
 * Drizzle's query builder reads the same across databases, so store logic is written once. The single
 * genuine difference between the two SQL drivers is HOW a built query runs: node-postgres executes when
 * you `await` the builder, while better-sqlite3 is synchronous and executes on `.all()` / `.run()`.
 * These tiny adapters hide that one difference so a store implementation never has to care which
 * database it's on. `NodePgDatabase` is used as the reference type the shared stores are written
 * against; a SQLite handle is passed with a single, well-understood cast at each factory.
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

/** A strictly-increasing ISO clock so timestamp columns never tie → deterministic ordering on any DB. */
export function monotonicIso(): () => string {
  let last = 0;
  return () => {
    const t = Math.max(Date.now(), last + 1);
    last = t;
    return new Date(t).toISOString();
  };
}

/** A strictly-increasing millisecond clock (for stores that key ordering on an integer timestamp). */
export function monotonicMillis(): () => number {
  let last = 0;
  return () => {
    const t = Math.max(Date.now(), last + 1);
    last = t;
    return t;
  };
}
