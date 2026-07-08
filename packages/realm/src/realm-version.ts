// SPDX-License-Identifier: MIT
/**
 * Realm version log — an append-only record of every version of a GLOBAL default the product has
 * published. It is the *baseline* store for drift detection.
 *
 * The analogy is your operating system's package manager. When a package ships a config file to
 * `/etc`, the package manager remembers the version it shipped. Later, on an upgrade, it compares
 * three things: what it shipped last time (the baseline), what's on disk now (maybe you edited it),
 * and what the new package wants to ship. Debian's `ucf`/dpkg-conffile handling keeps that baseline
 * in a side file precisely so it can tell "you changed this" from "we changed this". This log is that
 * side file for realm config: the last published version of each global default, kept out of the
 * live row so an operator's in-place edit never erases the baseline we measure drift against.
 *
 * It is append-only and content-addressed: publishing a payload whose content hash already matches the
 * latest version is a no-op (returns that version), so re-running a seed doesn't inflate history.
 */
import { newUUIDv7 } from '@weaveintel/core';
import { computeContentHash } from './realm-record.js';
import type { Payload } from './realm-store.js';

/** One immutable published version of a global default. */
export interface RealmVersion<T extends Payload = Payload> {
  readonly id: string;
  /** Which config family this belongs to, e.g. 'prompts' or 'prompt_fragments'. */
  readonly family: string;
  readonly logicalKey: string;
  /** 1-based, monotonic per (family, logicalKey). */
  readonly version: number;
  /** Content hash of `payload` — the drift *baseline* for this key. */
  readonly contentHash: string;
  readonly payload: T;
  readonly publishedAt: string;
  /** Optional actor: a package name/version, or an admin id. */
  readonly publishedBy?: string;
  readonly note?: string;
}

/** What a caller hands `append` — the log computes the hash, version number and timestamps. */
export interface PublishInput<T extends Payload = Payload> {
  readonly family: string;
  readonly logicalKey: string;
  readonly payload: T;
  readonly publishedBy?: string;
  readonly note?: string;
  /** Timestamp to stamp (ISO). Callers pass one so the log stays deterministic/testable. */
  readonly at?: string;
}

/**
 * Append-only history of published global defaults. `append` is content-addressed: publishing the
 * same content twice returns the existing latest version instead of creating a duplicate.
 */
export interface RealmVersionLog<T extends Payload = Payload> {
  append(input: PublishInput<T>): Promise<RealmVersion<T>>;
  /** The most recent published version for a key (the drift baseline), or null if never published. */
  latest(family: string, logicalKey: string): Promise<RealmVersion<T> | null>;
  /** Full history for a key, newest first. */
  history(family: string, logicalKey: string): Promise<Array<RealmVersion<T>>>;
  /** A specific version (for the diff workbench's "Base" payload). */
  at(family: string, logicalKey: string, version: number): Promise<RealmVersion<T> | null>;
  /** Every key's latest version in a family — the baseline snapshot a reconcile compares against. */
  latestAll(family: string): Promise<Map<string, RealmVersion<T>>>;
}

const DEFAULT_AT = '1970-01-01T00:00:00.000Z';

/** In-memory reference implementation (and the semantics every backend must match). */
export function createInMemoryVersionLog<T extends Payload = Payload>(): RealmVersionLog<T> {
  const rows: Array<RealmVersion<T>> = [];
  const keyFilter = (family: string, logicalKey: string) => (r: RealmVersion<T>) => r.family === family && r.logicalKey === logicalKey;

  return {
    async append(input) {
      const contentHash = computeContentHash(input.payload);
      const forKey = rows.filter(keyFilter(input.family, input.logicalKey)).sort((a, b) => b.version - a.version);
      const latest = forKey[0];
      // Content-addressed: same content as the latest → no new version.
      if (latest && latest.contentHash === contentHash) return latest;
      const version: RealmVersion<T> = {
        id: newUUIDv7(),
        family: input.family,
        logicalKey: input.logicalKey,
        version: (latest?.version ?? 0) + 1,
        contentHash,
        payload: input.payload,
        publishedAt: input.at ?? DEFAULT_AT,
        ...(input.publishedBy !== undefined ? { publishedBy: input.publishedBy } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      };
      rows.push(version);
      return version;
    },
    async latest(family, logicalKey) {
      const forKey = rows.filter(keyFilter(family, logicalKey)).sort((a, b) => b.version - a.version);
      return forKey[0] ?? null;
    },
    async history(family, logicalKey) {
      return rows.filter(keyFilter(family, logicalKey)).sort((a, b) => b.version - a.version);
    },
    async at(family, logicalKey, version) {
      return rows.find((r) => r.family === family && r.logicalKey === logicalKey && r.version === version) ?? null;
    },
    async latestAll(family) {
      const out = new Map<string, RealmVersion<T>>();
      for (const r of rows.filter((x) => x.family === family)) {
        const cur = out.get(r.logicalKey);
        if (!cur || r.version > cur.version) out.set(r.logicalKey, r);
      }
      return out;
    },
  };
}
