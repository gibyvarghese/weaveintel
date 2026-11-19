// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { BlockDoc } from './block-doc.js';
import { RgaDoc, type RgaOp } from './rga.js';
import { createBlockSyncJournal, createRgaSyncJournal } from './sync-journal.js';

describe('full-history collaboration sync', () => {
  it('repairs an out-of-order Lamport jump without treating skipped counters as gaps', () => {
    const source = new RgaDoc('alice');
    const first = source.localInsert(0, 'a');
    const remote: RgaOp = { type: 'ins', id: { siteId: 'clock', counter: 100 }, originId: null, value: 'r' };
    source.apply(remote);
    const later = source.localInsert(0, 'b');
    expect(later.id.counter).toBe(101);
    const sourceHistory = createRgaSyncJournal([first, remote, later]);
    const partialHistory = createRgaSyncJournal([later]);
    const partial = partialHistory.rebuild('bob');
    expect(source.opsSince(partial.stateVector())).not.toContainEqual(first);
    partialHistory.append(sourceHistory.entries());
    const caughtUp = partialHistory.rebuild('carol');
    expect(caughtUp.text()).toBe(source.text());
    expect(partialHistory.append(sourceHistory.entries())).toEqual([]);
  });

  it('persists pending inserts and deletes across restart, then integrates their dependency', () => {
    const source = new RgaDoc('alice');
    const [first, second] = source.localInsertText(0, 'ab');
    const deleted = source.localDelete(1)!;
    const journal = createRgaSyncJournal([second!, deleted]);
    const stored = JSON.parse(JSON.stringify(journal.entries())) as RgaOp[];
    const restored = createRgaSyncJournal(stored);
    const doc = restored.rebuild('fresh');
    expect(doc.text()).toBe('');
    const missing = restored.append([first!]);
    doc.applyMany(missing);
    expect(doc.text()).toBe(source.text());
    expect(restored.rebuild('another-fresh').text()).toBe(source.text());
    expect(() => restored.rebuild('alice')).toThrow(/site ID/);
  });

  it('exchanges offline edits in both directions and tolerates repeated reconnects', () => {
    const seed = new RgaDoc('seed');
    const seedOps = seed.localInsertText(0, 'ab');
    const leftHistory = createRgaSyncJournal(seedOps);
    const rightHistory = createRgaSyncJournal(seedOps);
    const left = leftHistory.rebuild('left');
    const right = rightHistory.rebuild('right');
    leftHistory.append(left.localInsertText(1, 'L'));
    rightHistory.append([right.localDelete(1)!]);
    const leftEntries = leftHistory.entries();
    const rightEntries = rightHistory.entries();
    leftHistory.append(rightEntries);
    rightHistory.append(leftEntries);
    expect(leftHistory.rebuild('left-new').text()).toBe(rightHistory.rebuild('right-new').text());
    expect(leftHistory.append(rightHistory.entries())).toEqual([]);
    expect(rightHistory.append(leftHistory.entries())).toEqual([]);
  });

  it('replays BlockDoc deletes, attributes, marks and pending operations from full history', () => {
    const source = new BlockDoc('alice');
    const { blockId, ops: blockOps } = source.insertBlock(null, 'paragraph');
    const textOps = source.insertText(blockId, 0, 'abc');
    const attr = source.setBlockType(blockId, 'heading');
    const mark = source.addMark(blockId, 0, 2, 'bold')!;
    const deletion = source.deleteText(blockId, 2, 1);
    const history = createBlockSyncJournal([textOps[1]!, ...deletion, mark, attr]);
    const restored = createBlockSyncJournal(JSON.parse(JSON.stringify(history.entries())));
    const replica = restored.rebuild('bob');
    replica.applyMany(restored.append([...blockOps, textOps[0]!, textOps[2]!]));
    expect(replica.blocks()).toEqual(source.blocks());
    expect(restored.rebuild('carol').blocks()).toEqual(source.blocks());
    expect(restored.append([...blockOps, ...textOps, attr, mark, ...deletion])).toEqual([]);
  });

  it('repairs a BlockDoc gap when a later independent attribute arrives first', () => {
    const source = new BlockDoc('alice');
    const first = source.insertText(null, 0, 'a')[0]!;
    const attr = source.setBlockAttr(null, 'type', 'heading');
    const partialHistory = createBlockSyncJournal([attr]);
    const partial = partialHistory.rebuild('bob');
    expect(source.opsSince(partial.stateVector())).not.toContainEqual(first);
    partialHistory.append([first]);
    expect(partialHistory.rebuild('carol').blocks()).toEqual(source.blocks());
  });

  it('rejects conflicting IDs atomically and detaches recorded operations', () => {
    const doc = new RgaDoc('alice');
    const [a, b] = doc.localInsertText(0, 'ab');
    const journal = createRgaSyncJournal([a!]);
    const conflict = { ...a!, value: 'z' } as RgaOp;
    expect(() => journal.append([b!, conflict])).toThrow(/Conflicting/);
    expect(journal.entries()).toEqual([a]);
    const copy = journal.entries();
    if (copy[0]!.type === 'ins') copy[0]!.value = 'changed';
    expect(journal.entries()).toEqual([a]);
    const reordered = JSON.parse('{"value":"a","originId":null,"id":{"siteId":"alice","counter":1},"type":"ins"}') as RgaOp;
    expect(journal.append([reordered])).toEqual([]);
  });

  it('rejects payloads that cannot round-trip through JSON instead of silently changing them', () => {
    const source = new BlockDoc('alice');
    const op = source.setBlockAttr(null, 'data', { unsupported: undefined });
    const journal = createBlockSyncJournal();
    expect(() => journal.append([op])).toThrow(/JSON/);
    expect(journal.entries()).toEqual([]);
    const valid = source.setBlockAttr(null, 'data', { x: 1 });
    expect(journal.append([valid])).toEqual([valid]);
    expect(() => journal.append([source.setBlockAttr(null, 'negativeZero', -0)])).toThrow(/JSON/);
  });
});
