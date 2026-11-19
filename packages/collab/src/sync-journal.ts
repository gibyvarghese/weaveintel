// SPDX-License-Identifier: MIT
import { BlockDoc, blockOpId, type BlockOp } from './block-doc.js';
import { RgaDoc, opIdOf, type RgaId, type RgaOp } from './rga.js';

/**
 * An opt-in, complete operation history. Retain every accepted local and remote
 * operation, including those buffered by the document. Unlike a state vector,
 * this history makes no assumptions about gaps in Lamport counters.
 *
 * This in-memory object is not durable; the host must atomically persist its
 * entries and coordinate document edits, acknowledgements and replay.
 */
export interface SyncJournal<Op, Doc> {
  /** Append a batch atomically; identical duplicates are ignored, conflicting IDs throw. */
  append(operations: readonly Op[]): Op[];
  /** A detached, JSON-compatible copy of the complete history for persistence or exchange. */
  entries(): Op[];
  /** Replay the complete history, including pending operations, into a fresh replica. */
  rebuild(freshSiteId: string): Doc;
}

// Canonical JSON also detects ID reuse with a different payload. Reject values
// that JSON would silently alter, rather than persisting a different operation.
function canonicalJson(value: unknown, active = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return JSON.stringify(value);
  if (typeof value !== 'object' || value === null) throw new Error('Operation must contain only JSON values');
  if (active.has(value)) throw new Error('Operation must not contain cycles');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).some((key) => key !== 'length'
        && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
        throw new Error('Operation arrays must contain only indexed JSON values');
      }
      const entries: string[] = [];
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new Error('Operation must not contain sparse arrays or accessors');
        }
        entries.push(canonicalJson(descriptor.value, active));
      }
      return `[${entries.join(',')}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error('Operation must contain only plain JSON objects');
    }
    const obj = value as Record<string, unknown>;
    const keys = Reflect.ownKeys(obj);
    if (keys.some((key) => typeof key !== 'string')) throw new Error('Operation must not contain symbol keys');
    return `{${(keys as string[]).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(obj, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw new Error('Operation must not contain hidden properties or accessors');
      }
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, active)}`;
    }).join(',')}}`;
  } finally {
    active.delete(value);
  }
}

function keyFor(id: RgaId): string {
  if (!id || typeof id.siteId !== 'string' || !id.siteId || !Number.isSafeInteger(id.counter) || id.counter <= 0) {
    throw new Error('Invalid operation ID');
  }
  return JSON.stringify([id.siteId, id.counter]);
}

function createJournal<Op, Doc>(
  getId: (op: Op) => RgaId,
  makeDoc: (siteId: string) => Doc,
  apply: (doc: Doc, ops: Op[]) => void,
  initial: readonly Op[],
): SyncJournal<Op, Doc> {
  const entries = new Map<string, string>();
  const journal: SyncJournal<Op, Doc> = {
    append(operations) {
      const staged = new Map<string, string>();
      for (const op of operations) {
        const encoded = canonicalJson(op);
        const parsed = JSON.parse(encoded) as Op;
        const key = keyFor(getId(parsed));
        const previous = staged.get(key) ?? entries.get(key);
        if (previous !== undefined && previous !== encoded) throw new Error('Conflicting operation ID');
        if (previous === undefined) staged.set(key, encoded);
      }
      for (const [key, encoded] of staged) entries.set(key, encoded);
      return [...staged.values()].map((encoded) => JSON.parse(encoded) as Op);
    },
    entries() {
      return [...entries.values()].map((encoded) => JSON.parse(encoded) as Op);
    },
    rebuild(freshSiteId) {
      if (typeof freshSiteId !== 'string' || !freshSiteId) throw new Error('A fresh site ID is required');
      const operations = journal.entries();
      if (operations.some((op) => getId(op).siteId === freshSiteId)) {
        throw new Error('Rebuild requires a site ID not used in the history');
      }
      const doc = makeDoc(freshSiteId);
      apply(doc, operations);
      return doc;
    },
  };
  journal.append(initial);
  return journal;
}

/** Full-history sync for RgaDoc; the host must capture every operation from inception. */
export function createRgaSyncJournal(initial: readonly RgaOp[] = []): SyncJournal<RgaOp, RgaDoc> {
  return createJournal(opIdOf, (siteId) => new RgaDoc(siteId), (doc, ops) => { doc.applyMany(ops); }, initial);
}

/** Full-history sync for BlockDoc; ordinary BlockDoc snapshots are not full histories. */
export function createBlockSyncJournal(initial: readonly BlockOp[] = []): SyncJournal<BlockOp, BlockDoc> {
  return createJournal(blockOpId, (siteId) => new BlockDoc(siteId), (doc, ops) => { doc.applyMany(ops); }, initial);
}
