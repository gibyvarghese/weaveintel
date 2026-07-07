// SPDX-License-Identifier: MIT
/**
 * The Postgres NoteRepository adapter, proven against a REAL Postgres (Testcontainers — a throwaway
 * container, no mocks, no external DB). Skipped automatically when Docker isn't available.
 *
 *   1. The SHARED contract — the exact same battery the in-memory reference passes — run against the
 *      Postgres adapter. Passing it proves the two behave identically behind the one port.
 *   2. Negative / security — a hostile note title/body full of SQL metacharacters is stored as DATA
 *      (parameterised), and owner-scoping can't be bypassed.
 *   3. Stress — a large workspace (2,000 notes for one user) lists and searches correctly and quickly.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createPostgresNoteRepository } from './note-repository-postgres.js';
import { noteRepositoryContract } from './note-repository-contract.js';

function hasDocker(): boolean {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_DOCKER = hasDocker();

function loadKey(): string | undefined {
  if (process.env['OPENAI_API_KEY']) return process.env['OPENAI_API_KEY'];
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../../.env', '../../.env', '../.env']) {
    try { const m = readFileSync(join(here, rel), 'utf8').match(/^OPENAI_API_KEY=(.+)$/m); if (m) return m[1]!.trim().replace(/^["']|["']$/g, ''); } catch { /* */ }
  }
  return undefined;
}
const KEY = loadKey();

describe.skipIf(!HAS_DOCKER)('Postgres NoteRepository (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    // Create the schema once up front so the shared contract's fresh-repo-per-test is quick.
    createPostgresNoteRepository({ pool });
    await pool.query('SELECT 1'); // warm the pool
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await container?.stop().catch(() => {});
  });

  // 1) The SAME contract the in-memory reference passes — now on real Postgres.
  //    Each test gets a fresh repo but shares the pool/tables; the contract uses unique ids per run.
  noteRepositoryContract(() => createPostgresNoteRepository({ pool }), { describe, it, beforeEach, expect } as never);

  // 2) Security: SQL metacharacters in user content are stored as data, not executed.
  it('SECURITY: a hostile title/body cannot drop the table (parameterised)', async () => {
    const repo = createPostgresNoteRepository({ pool });
    const hostile = `'; DROP TABLE notes; -- "x" \\ %_`;
    await repo.createNote({ id: 'sec-1', owner_user_id: 'sec-user', title: hostile, doc_json: `{"t":"${'a'}"}` });
    const got = await repo.getNote('sec-1', 'sec-user');
    expect(got?.title).toBe(hostile); // stored verbatim
    // The table still works afterwards (the injection did not execute).
    await repo.createNote({ id: 'sec-2', owner_user_id: 'sec-user', title: 'still here' });
    expect((await repo.getNote('sec-2', 'sec-user'))?.title).toBe('still here');
  }, 60_000);

  it('SECURITY: search wildcards in the query are treated literally (no % blowup, owner-scoped)', async () => {
    const repo = createPostgresNoteRepository({ pool });
    await repo.createNote({ id: 'wc-1', owner_user_id: 'wc-user', title: 'plain title' });
    await repo.createNote({ id: 'wc-2', owner_user_id: 'wc-user', title: '100% cotton' });
    // '%' must match the literal percent, not "everything".
    const pct = await repo.listNotes('wc-user', { search: '100%' });
    expect(pct.some((n) => n.id === 'wc-2')).toBe(true);
    expect(pct.some((n) => n.id === 'wc-1')).toBe(false);
    // A different user sees none of these.
    expect(await repo.listNotes('other-user', { search: 'title' })).toHaveLength(0);
  }, 60_000);

  // 3) Stress: a big single-user workspace stays correct and fast.
  it('STRESS: 2,000 notes for one user list/search/paginate correctly', async () => {
    const repo = createPostgresNoteRepository({ pool });
    const user = 'stress-user';
    const t0 = Date.now();
    for (let i = 0; i < 2000; i += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, j) => {
        const n = i + j;
        return repo.createNote({
          id: `stress-${n}`, owner_user_id: user, title: `Note ${n}`,
          favorite: n === 1234 ? 1 : 0,
          doc_json: `{"type":"doc","content":[{"type":"text","text":"body ${n} keyword${n % 7 === 0 ? ' findme' : ''}"}]}`,
        });
      }));
    }
    const listed = await repo.listNotes(user, { limit: 5000 });
    expect(listed).toHaveLength(2000);
    expect(listed[0]?.favorite).toBe(1); // the one favourite sorts to the top
    const found = await repo.listNotes(user, { search: 'findme', limit: 5000 });
    expect(found.length).toBe(Math.floor(2000 / 7) + 1); // n % 7 === 0 → 0,7,14,… plus 0
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);

  // 4) REAL LLM: an AI drafts a note; it's durably stored in Postgres and findable by search.
  it.skipIf(!KEY)('REAL LLM: an AI-written note is persisted to Postgres and found by search', async () => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: 'Write short meeting minutes for a product sync about the Q3 launch of "Project Nimbus". '
            + 'Reply as strict JSON: {"title": string, "summary": string with 2-3 sentences mentioning Project Nimbus}.',
        }],
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    const drafted = JSON.parse(json.choices[0]!.message.content) as { title: string; summary: string };
    expect(drafted.title.length).toBeGreaterThan(0);

    // Store the AI's note through the REAL Postgres adapter (as an app would), as a ProseMirror doc.
    const repo = createPostgresNoteRepository({ pool });
    const user = 'ai-author';
    const doc = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: drafted.summary }] }] });
    await repo.createNote({ id: 'ai-note-1', owner_user_id: user, title: drafted.title, doc_json: doc });

    // It round-trips byte-for-byte…
    const stored = await repo.getNote('ai-note-1', user);
    expect(stored?.title).toBe(drafted.title);
    expect(stored?.doc_json).toBe(doc);
    // …and the workspace search finds it by a word the model actually wrote.
    const hits = await repo.listNotes(user, { search: 'Nimbus' });
    expect(hits.some((n) => n.id === 'ai-note-1')).toBe(true);
  }, 120_000);
});
