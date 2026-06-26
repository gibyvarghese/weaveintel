// SPDX-License-Identifier: MIT
/**
 * Shared conformance test for any {@link NoteRepository} adapter (weaveNotes Phase 0).
 * The in-memory reference adapter and geneWeave's SQL adapter must BOTH pass it —
 * proving identical behaviour behind the one port (the Collaboration Phase 0–7
 * pattern). This is the safety net that lets us refactor geneWeave's routes onto
 * the port with confidence that behaviour did not change.
 */
import type { NoteRepository } from './note-repository.js';

export interface ContractTestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  beforeEach: (fn: () => void | Promise<void>) => void;
  expect: (actual: unknown) => {
    toBe(v: unknown): void;
    toEqual(v: unknown): void;
    toBeNull(): void;
    toContain(v: unknown): void;
    toHaveLength(n: number): void;
    not: { toBeNull(): void; toContain(v: unknown): void; toBe(v: unknown): void };
    [k: string]: unknown;
  };
}

let counter = 0;
function nextId(prefix: string): string { return `${prefix}-${++counter}`; }

export function noteRepositoryContract(make: () => Promise<NoteRepository> | NoteRepository, t: ContractTestApi): void {
  const { describe, it, beforeEach, expect } = t;
  describe('NoteRepository contract', () => {
    let repo: NoteRepository;
    let user: string;
    beforeEach(async () => { repo = await make(); user = nextId('user'); });

    async function newNote(over: Partial<Parameters<NoteRepository['createNote']>[0]> = {}) {
      const id = nextId('note');
      await repo.createNote({ id, owner_user_id: user, title: 'Untitled', ...over });
      return id;
    }

    it('createNote → getNote round-trips with defaults applied', async () => {
      const id = await newNote({ title: 'My note' });
      const n = await repo.getNote(id, user);
      expect(n?.title).toBe('My note');
      expect(n?.sensitivity).toBe('normal');           // default
      expect(n?.is_template).toBe(0);
      expect(typeof n?.doc_json).toBe('string');        // default doc
      expect(n?.created_at).not.toBe(undefined);
    });

    it('getNote is owner-scoped (another user cannot read it) but resolves `_system` templates', async () => {
      const id = await newNote();
      expect(await repo.getNote(id, 'someone-else')).toBeNull();
      const sysId = nextId('tmpl');
      await repo.createNote({ id: sysId, owner_user_id: '_system', title: 'System Template', is_template: 1 });
      expect((await repo.getNote(sysId, user))?.title).toBe('System Template'); // any user can read a system template
    });

    it('listNotes excludes templates, is owner-scoped, and respects parent/favorite/search/limit', async () => {
      await newNote({ title: 'Alpha' });
      const fav = await newNote({ title: 'Beta', favorite: 1 });
      await newNote({ title: 'Gamma', doc_json: '{"type":"doc","content":[{"type":"text","text":"needle"}]}' });
      await repo.createNote({ id: nextId('tmpl'), owner_user_id: user, title: 'A Template', is_template: 1 });
      const child = nextId('child');
      const parent = await newNote({ title: 'Parent' });
      await repo.createNote({ id: child, owner_user_id: user, title: 'Child', parent_note_id: parent });

      const all = await repo.listNotes(user);
      expect(all.some((n) => n.is_template === 1)).toBe(false);     // templates excluded
      expect(all.some((n) => n.id === child)).toBe(true);

      // Owner scoping.
      expect(await repo.listNotes('nobody')).toHaveLength(0);
      // Top-level filter excludes the child.
      const top = await repo.listNotes(user, { parentNoteId: null });
      expect(top.some((n) => n.id === child)).toBe(false);
      // Children of `parent`.
      const kids = await repo.listNotes(user, { parentNoteId: parent });
      expect(kids).toHaveLength(1);
      // Favorite filter.
      const favs = await repo.listNotes(user, { favorite: true });
      expect(favs.every((n) => n.favorite === 1)).toBe(true);
      expect(favs.some((n) => n.id === fav)).toBe(true);
      // Search matches title OR doc_json.
      expect((await repo.listNotes(user, { search: 'needle' })).some((n) => n.title === 'Gamma')).toBe(true);
      expect((await repo.listNotes(user, { search: 'Alpha' })).some((n) => n.title === 'Alpha')).toBe(true);
      // Limit.
      expect((await repo.listNotes(user, { limit: 1 }))).toHaveLength(1);
      // Favorites sort first.
      expect((await repo.listNotes(user))[0]?.favorite).toBe(1);
    });

    it('updateNote is owner-scoped, bumps updated_at, and a no-op patch does nothing', async () => {
      const id = await newNote({ title: 'Before' });
      await repo.updateNote(id, 'wrong-user', { title: 'Hacked' });
      expect((await repo.getNote(id, user))?.title).toBe('Before'); // not changed by a non-owner
      await repo.updateNote(id, user, { title: 'After', favorite: 1 });
      const n = await repo.getNote(id, user);
      expect(n?.title).toBe('After');
      expect(n?.favorite).toBe(1);
      await repo.updateNote(id, user, {}); // no-op
      expect((await repo.getNote(id, user))?.title).toBe('After');
    });

    it('deleteNote cascades one level of sub-pages + their links, owner-scoped', async () => {
      const parent = await newNote({ title: 'Parent' });
      const child = nextId('child');
      await repo.createNote({ id: child, owner_user_id: user, title: 'Child', parent_note_id: parent });
      await repo.createLink({ id: nextId('lnk'), note_id: child, target_kind: 'task', target_id: 't1' });
      expect(await repo.deleteNote(parent, 'wrong-user')).toBe(false);        // non-owner cannot delete
      expect(await repo.deleteNote(parent, user)).toBe(true);
      expect(await repo.getNote(parent, user)).toBeNull();
      expect(await repo.getNote(child, user)).toBeNull();                      // sub-page gone
      expect(await repo.listLinks(child)).toHaveLength(0);                     // its links gone
      expect(await repo.deleteNote('ghost', user)).toBe(false);               // unknown → false
    });

    it('links: create/list/backlinks/delete with correct ordering + scoping', async () => {
      const a = await newNote(); const b = await newNote();
      await repo.createLink({ id: nextId('lnk'), note_id: a, target_kind: 'run', target_id: 'run-X' });
      await repo.createLink({ id: nextId('lnk'), note_id: b, target_kind: 'run', target_id: 'run-X' });
      expect(await repo.listLinks(a)).toHaveLength(1);
      // Backlinks = every note pointing AT run-X.
      const back = await repo.listBacklinks('run', 'run-X');
      expect(back).toHaveLength(2);
      const someLink = (await repo.listLinks(a))[0]!;
      await repo.deleteLink(someLink.id, 'wrong-note'); // wrong parent → no delete
      expect(await repo.listLinks(a)).toHaveLength(1);
      await repo.deleteLink(someLink.id, a);
      expect(await repo.listLinks(a)).toHaveLength(0);
    });

    it('databases + rows: create/list/get/update/delete with scoping + cascade', async () => {
      const dbId = nextId('db');
      await repo.createDatabase({ id: dbId, owner_user_id: user, name: 'Reading list', source: 'generic', view_type: 'table' });
      expect((await repo.getDatabase(dbId, user))?.name).toBe('Reading list');
      expect(await repo.getDatabase(dbId, 'nope')).toBeNull();                 // owner-scoped
      const rowId = nextId('row');
      await repo.createRow({ id: rowId, database_id: dbId, fields_json: '{"a":1}' });
      expect(await repo.listRows(dbId)).toHaveLength(1);
      await repo.updateRow(rowId, dbId, '{"a":2}');
      expect((await repo.listRows(dbId))[0]?.fields_json).toBe('{"a":2}');
      await repo.updateRow(rowId, 'wrong-db', '{"a":3}');                      // wrong parent → no change
      expect((await repo.listRows(dbId))[0]?.fields_json).toBe('{"a":2}');
      await repo.deleteDatabase(dbId, user);
      expect(await repo.getDatabase(dbId, user)).toBeNull();
      expect(await repo.listRows(dbId)).toHaveLength(0);                       // rows cascade
    });
  });
}
