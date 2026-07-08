// SPDX-License-Identifier: MIT
/**
 * Reconcile shipped defaults with what's actually in the store — the "self-upgrade" engine.
 *
 * When the product ships a new version, some of its built-in defaults change. Meanwhile an operator may
 * have edited some of those defaults in place. We must never silently clobber the operator, and never
 * leave them stuck on a stale default. This is exactly what your OS package manager does with a config
 * file in /etc on upgrade — Debian's dpkg/ucf keeps the version it shipped last time (the *baseline*),
 * and compares three things:
 *
 *   • Base   — what we shipped last time            (the version log's latest entry)
 *   • Local  — what's in the store now              (may carry operator edits)
 *   • Remote — what the new release wants to ship   (the desired default handed in)
 *
 * and classifies each default:
 *
 *   • in_sync    — you didn't touch it, we didn't change it → nothing to do
 *   • customized — you edited it, we didn't → keep yours (never overwritten)
 *   • stale      — you didn't touch it, we changed it → safe to adopt the new default automatically
 *   • diverged   — both changed → leave it, flag for review (a real merge, like ucf's 3-way prompt)
 *   • new        — we ship a default that isn't in the store yet → publish it
 *   • removed    — the store has a managed default we no longer ship → flag, never auto-delete
 *
 * `planReconcile` is the read-only report (a "terraform plan" for config). `reconcile` applies the safe
 * moves (publish new, adopt stale) and returns what still needs a human. Nothing here is destructive by
 * default.
 */
import { computeContentHash, driftState, type DriftState } from './realm-record.js';
import type { Payload, RealmConfigStore } from './realm-store.js';
import type { RealmVersionLog } from './realm-version.js';

/** One shipped default from the current release (Remote). */
export interface DesiredDefault<T extends Payload = Payload> {
  readonly logicalKey: string;
  readonly payload: T;
}

export type ReconcileState = DriftState | 'new' | 'removed';

export interface DriftEntry<T extends Payload = Payload> {
  readonly logicalKey: string;
  readonly state: ReconcileState;
  readonly base: string | null;   // last published version's hash
  readonly local: string | null;  // current global row's hash
  readonly remote: string | null; // desired default's hash
  /** Payloads for the diff/merge workbench (only populated where meaningful). */
  readonly basePayload?: T;
  readonly localPayload?: T;
  readonly remotePayload?: T;
}

export interface DriftReport<T extends Payload = Payload> {
  readonly entries: Array<DriftEntry<T>>;
  readonly summary: Record<ReconcileState, number>;
}

const EMPTY_SUMMARY = (): Record<ReconcileState, number> =>
  ({ in_sync: 0, customized: 0, stale: 0, diverged: 0, new: 0, removed: 0 });

/** Classify one key from its three hashes. base=null means "never recorded a baseline" (unmanaged). */
export function classifyDrift(base: string | null, local: string | null, remote: string | null): ReconcileState {
  if (local == null) return remote != null ? 'new' : 'in_sync';
  if (remote == null) return 'removed';
  // Both present now (local, remote both non-null).
  if (base == null) return local === remote ? 'in_sync' : 'diverged'; // unmanaged → never auto-overwrite
  const d = driftState(base, local, remote);
  return d === 'not_a_fork' ? 'diverged' : d; // base is non-null here, so this is unreachable, but keeps it safe
}

/** Inputs to the pure planner — snapshots, so it needs no store/log. */
export interface ReconcilePlanInput<T extends Payload = Payload> {
  /** Current global rows keyed by logicalKey (Local). */
  readonly current: Map<string, { contentHash: string; payload: T }>;
  /** Latest published version keyed by logicalKey (Base). */
  readonly baseline: Map<string, { contentHash: string; payload: T }>;
  /** The release's desired defaults (Remote). */
  readonly desired: ReadonlyArray<DesiredDefault<T>>;
}

/** Read-only drift report — the "plan". Considers every key present on any side. */
export function planReconcile<T extends Payload = Payload>(input: ReconcilePlanInput<T>): DriftReport<T> {
  const { current, baseline, desired } = input;
  const desiredByKey = new Map(desired.map((d) => [d.logicalKey, d]));
  const keys = new Set<string>([...current.keys(), ...baseline.keys(), ...desiredByKey.keys()]);
  const entries: Array<DriftEntry<T>> = [];
  const summary = EMPTY_SUMMARY();

  for (const logicalKey of [...keys].sort()) {
    const cur = current.get(logicalKey);
    const base = baseline.get(logicalKey);
    const des = desiredByKey.get(logicalKey);
    const localHash = cur?.contentHash ?? null;
    const baseHash = base?.contentHash ?? null;
    const remoteHash = des ? computeContentHash(des.payload) : null;
    const state = classifyDrift(baseHash, localHash, remoteHash);
    summary[state] += 1;
    entries.push({
      logicalKey, state, base: baseHash, local: localHash, remote: remoteHash,
      ...(base ? { basePayload: base.payload } : {}),
      ...(cur ? { localPayload: cur.payload } : {}),
      ...(des ? { remotePayload: des.payload } : {}),
    });
  }
  return { entries, summary };
}

export interface ReconcileOptions {
  /** Adopt 'stale' defaults automatically (operator didn't touch them). Default true. */
  readonly autoAdoptStale?: boolean;
  /** Publish 'new' defaults the store doesn't have yet. Default true. */
  readonly publishNew?: boolean;
  /** Stamp on version-log entries this reconcile writes. */
  readonly publishedBy?: string;
  readonly at?: string;
}

export interface ReconcileResult<T extends Payload = Payload> {
  readonly report: DriftReport<T>;
  /** Keys this reconcile changed, with what it did. */
  readonly applied: Array<{ logicalKey: string; action: 'published' | 'adopted' }>;
  /** Keys a human still needs to look at (customized / diverged / removed). */
  readonly needsReview: Array<{ logicalKey: string; state: ReconcileState }>;
}

/**
 * Apply the safe moves and report the rest. Publishes new defaults, adopts stale ones (recording a new
 * baseline version), and leaves customized/diverged/removed for a human. Every write goes through the
 * store + version log — the same path a fresh seed uses — so this doubles as the seeding mechanism
 * (`PublishToRealm`): a first run publishes everything as `new`; later runs reconcile.
 */
export async function reconcile<T extends Payload = Payload>(
  store: RealmConfigStore<T>,
  versionLog: RealmVersionLog<T>,
  family: string,
  desired: ReadonlyArray<DesiredDefault<T>>,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult<T>> {
  const autoAdoptStale = opts.autoAdoptStale ?? true;
  const publishNew = opts.publishNew ?? true;

  // Snapshot current globals + baselines.
  const keys = desired.map((d) => d.logicalKey);
  const allGlobals = (await store.listAll(keys)).filter((r) => r.realm === 'global');
  const current = new Map(allGlobals.map((r) => [r.logicalKey, { contentHash: r.contentHash, payload: r as unknown as T }]));
  const baselineVersions = await versionLog.latestAll(family);
  const baseline = new Map([...baselineVersions].map(([k, v]) => [k, { contentHash: v.contentHash, payload: v.payload }]));

  const report = planReconcile<T>({ current, baseline, desired });
  const applied: ReconcileResult<T>['applied'] = [];
  const needsReview: ReconcileResult<T>['needsReview'] = [];
  const desiredByKey = new Map(desired.map((d) => [d.logicalKey, d]));

  for (const entry of report.entries) {
    const des = desiredByKey.get(entry.logicalKey);
    if ((entry.state === 'new') && des && publishNew) {
      await store.publishGlobal(entry.logicalKey, des.payload);
      await versionLog.append({ family, logicalKey: entry.logicalKey, payload: des.payload, publishedBy: opts.publishedBy, note: 'publish', at: opts.at });
      applied.push({ logicalKey: entry.logicalKey, action: 'published' });
    } else if (entry.state === 'stale' && des && autoAdoptStale) {
      await store.publishGlobal(entry.logicalKey, des.payload);
      await versionLog.append({ family, logicalKey: entry.logicalKey, payload: des.payload, publishedBy: opts.publishedBy, note: 'adopt', at: opts.at });
      applied.push({ logicalKey: entry.logicalKey, action: 'adopted' });
    } else if (entry.state === 'customized' || entry.state === 'diverged' || entry.state === 'removed') {
      needsReview.push({ logicalKey: entry.logicalKey, state: entry.state });
    }
  }
  return { report, applied, needsReview };
}

/**
 * Force "take the shipped version" for one key — the operator's explicit choice on a customized/diverged
 * default (like `ucf`'s "install the package maintainer's version"). Overwrites the global and records a
 * fresh baseline so drift returns to in_sync.
 */
export async function resyncToDesired<T extends Payload = Payload>(
  store: RealmConfigStore<T>,
  versionLog: RealmVersionLog<T>,
  family: string,
  logicalKey: string,
  payload: T,
  opts: { publishedBy?: string; at?: string } = {},
): Promise<void> {
  await store.publishGlobal(logicalKey, payload);
  await versionLog.append({ family, logicalKey, payload, publishedBy: opts.publishedBy, note: 'resync', at: opts.at });
}

/**
 * Publish a single global default and record its version — `PublishToRealm` for one record. Idempotent
 * on unchanged content (the version log dedupes). This is what an admin "save a global default" calls.
 */
export async function publishToRealm<T extends Payload = Payload>(
  store: RealmConfigStore<T>,
  versionLog: RealmVersionLog<T>,
  family: string,
  logicalKey: string,
  payload: T,
  opts: { publishedBy?: string; note?: string; at?: string } = {},
): Promise<{ contentHash: string }> {
  const rec = await store.publishGlobal(logicalKey, payload);
  await versionLog.append({ family, logicalKey, payload, publishedBy: opts.publishedBy, note: opts.note ?? 'publish', at: opts.at });
  return { contentHash: rec.contentHash };
}
