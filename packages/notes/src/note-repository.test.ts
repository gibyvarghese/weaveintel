// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryNoteRepository, type NoteRepository } from './note-repository.js';
import { noteRepositoryContract } from './note-repository-contract.js';

// The in-memory reference adapter must pass the shared contract.
noteRepositoryContract(() => createInMemoryNoteRepository(), { describe, it, beforeEach, expect } as never);

describe('NoteRepository — stress & isolation (in-memory)', () => {
  let repo: NoteRepository;
  beforeEach(() => { repo = createInMemoryNoteRepository(); });

  it('keeps each user fully isolated under a large workspace', async () => {
    for (let u = 0; u < 5; u++) {
      for (let i = 0; i < 100; i++) {
        await repo.createNote({ id: `u${u}-n${i}`, owner_user_id: `user-${u}`, title: `Note ${i}`, favorite: i % 7 === 0 ? 1 : 0 });
      }
    }
    expect((await repo.listNotes('user-2', { limit: 1000 })).length).toBe(100);
    expect((await repo.listNotes('user-2', { favorite: true, limit: 1000 })).every((n) => n.owner_user_id === 'user-2')).toBe(true);
    // No cross-user leakage.
    expect(await repo.getNote('u3-n5', 'user-2')).toBeNull();
    expect((await repo.getNote('u3-n5', 'user-3'))?.title).toBe('Note 5');
  });

  it('search is case-insensitive over title and doc body', async () => {
    await repo.createNote({ id: 'n1', owner_user_id: 'u', title: 'Quarterly REVIEW', doc_json: '{}' });
    await repo.createNote({ id: 'n2', owner_user_id: 'u', title: 'Other', doc_json: '{"type":"doc","content":[{"type":"text","text":"the SECRET plan"}]}' });
    expect((await repo.listNotes('u', { search: 'review' })).map((n) => n.id)).toContain('n1');
    expect((await repo.listNotes('u', { search: 'secret' })).map((n) => n.id)).toContain('n2');
  });

  it('a deeply-nested delete only cascades ONE level (matches SQL behaviour)', async () => {
    await repo.createNote({ id: 'root', owner_user_id: 'u', title: 'root' });
    await repo.createNote({ id: 'child', owner_user_id: 'u', title: 'child', parent_note_id: 'root' });
    await repo.createNote({ id: 'grandchild', owner_user_id: 'u', title: 'gc', parent_note_id: 'child' });
    await repo.deleteNote('root', 'u');
    expect(await repo.getNote('root', 'u')).toBeNull();
    expect(await repo.getNote('child', 'u')).toBeNull();       // one level cascaded
    expect(await repo.getNote('grandchild', 'u')).not.toBeNull(); // grandchild survives (documented quirk)
  });
});
