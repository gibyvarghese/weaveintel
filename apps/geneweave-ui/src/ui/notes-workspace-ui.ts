// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 8 — UI panels: version History, block Comments, Synced blocks, and the
 * "Ask your workspace" (RAG) search box.
 *
 * Each editor panel follows the Phase 5 Connections-panel pattern: a `wire…()` function that
 * renders into a host element and returns `{ refresh, close }`, so the panel survives the
 * editor's re-renders (it is wired once in the mount block; a toolbar button toggles its
 * visibility). The workspace-search box lives in the notes LIST so you can ask a question
 * across all your notes + past chats and get cited excerpts back.
 *
 * --- For someone new to this ---
 * • History = "save points" for a note you can roll back to.
 * • Comments = sticky notes / discussion threads on the note.
 * • Synced = a live mirror of a paragraph from ANOTHER note (edit it once, it updates here too).
 * • Ask your workspace = search your own notes + chats and get answers with clickable sources.
 */
import { h } from './dom.js';
import { api } from './api.js';

export interface SimplePanel { refresh(): Promise<void>; close(): void }

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Version history ─────────────────────────────────────────────────────────────

interface VersionSummary { id: string; title: string; label: string | null; reason: string; wordCount: number; createdAt: number }

export function wireNoteHistory(opts: { noteId: string; panelEl: HTMLElement; onRestored: () => void }): SimplePanel {
  const { noteId, panelEl, onRestored } = opts;
  let closed = false;

  async function refresh(): Promise<void> {
    if (closed) return;
    panelEl.replaceChildren(h('div', { className: 'notes-ws-loading' }, 'Loading history…'));
    let versions: VersionSummary[] = [];
    try { const res = await api.get(`/api/me/notes/${noteId}/versions`); if (res.ok) versions = (await res.json() as { versions: VersionSummary[] }).versions; } catch { /* */ }
    if (closed) return;

    const saveBtn = h('button', {
      className: 'notes-ws-action',
      onClick: async () => { await api.post(`/api/me/notes/${noteId}/versions`, {}).catch(() => undefined); await refresh(); },
    }, '💾 Save version');

    panelEl.replaceChildren(
      h('div', { className: 'notes-ws-head' }, h('span', { className: 'notes-ws-title' }, '📜 Version history'), saveBtn),
      versions.length === 0
        ? h('div', { className: 'notes-ws-empty' }, 'No saved versions yet. Save one to start a timeline.')
        : h('div', { className: 'notes-ws-list' },
            ...versions.map((v) => h('div', { className: 'notes-ws-row' },
              h('div', { className: 'notes-ws-row-main' },
                h('span', { className: 'notes-ws-row-title' }, v.label || (v.reason === 'restore' ? 'Before restore' : 'Snapshot')),
                h('span', { className: 'notes-ws-row-meta' }, `${v.wordCount} words · ${timeAgo(v.createdAt)}`),
              ),
              h('button', {
                className: 'notes-ws-restore',
                title: 'Restore this version (your current draft is saved first)',
                onClick: async () => {
                  if (!confirm('Restore this version? Your current content is saved to history first.')) return;
                  const res = await api.post(`/api/me/notes/${noteId}/versions/${v.id}/restore`, {}).catch(() => null);
                  if (res && res.ok) { onRestored(); await refresh(); }
                },
              }, '↶ Restore'),
            )),
          ),
    );
  }

  return { refresh, close: () => { closed = true; } };
}

// ── Block comments ──────────────────────────────────────────────────────────────

interface CommentView { id: string; threadId: string; parentId: string | null; authorId: string; body: string; bodyHtml: string; anchorBlockId: string; createdAt: number; deletedAt: number | null; resolvedAt: number | null }

export function wireNoteComments(opts: { noteId: string; panelEl: HTMLElement }): SimplePanel {
  const { noteId, panelEl } = opts;
  let closed = false;

  async function post(body: string, parentId?: string): Promise<void> {
    if (!body.trim()) return;
    await api.post(`/api/me/notes/${noteId}/comments`, { body, ...(parentId ? { parentId } : {}) }).catch(() => undefined);
    await refresh();
  }

  async function refresh(): Promise<void> {
    if (closed) return;
    let comments: CommentView[] = [];
    try { const res = await api.get(`/api/me/notes/${noteId}/comments`); if (res.ok) comments = (await res.json() as { comments: CommentView[] }).comments; } catch { /* */ }
    if (closed) return;

    // Group into threads (roots + their replies).
    const roots = comments.filter((c) => c.id === c.threadId);
    const repliesByThread = new Map<string, CommentView[]>();
    for (const c of comments) if (c.id !== c.threadId) { const arr = repliesByThread.get(c.threadId) ?? []; arr.push(c); repliesByThread.set(c.threadId, arr); }

    const input = h('textarea', { className: 'notes-ws-comment-input', rows: 2, placeholder: 'Add a comment…' }) as HTMLTextAreaElement;
    const addBtn = h('button', { className: 'notes-ws-action', onClick: () => { const v = input.value; input.value = ''; void post(v); } }, 'Comment');

    function renderComment(c: CommentView, isRoot: boolean): HTMLElement {
      const bodyEl = h('div', { className: 'notes-ws-comment-body' }) as HTMLElement;
      bodyEl.innerHTML = c.deletedAt ? '<em>(deleted)</em>' : c.bodyHtml;
      const actions: HTMLElement[] = [];
      if (isRoot && !c.deletedAt) {
        actions.push(h('button', {
          className: 'notes-ws-link',
          onClick: async () => { await api.post(`/api/me/notes/${noteId}/comments/${c.id}/resolve`, { resolved: !c.resolvedAt }).catch(() => undefined); await refresh(); },
        }, c.resolvedAt ? '↺ Reopen' : '✓ Resolve'));
      }
      return h('div', { className: `notes-ws-comment${c.resolvedAt ? ' resolved' : ''}${isRoot ? ' root' : ' reply'}` },
        h('div', { className: 'notes-ws-comment-head' },
          h('span', { className: 'notes-ws-comment-author' }, c.authorId.slice(0, 12)),
          h('span', { className: 'notes-ws-row-meta' }, timeAgo(c.createdAt)),
          c.resolvedAt ? h('span', { className: 'notes-ws-resolved-badge' }, 'resolved') : null,
          ...actions,
        ),
        bodyEl,
      );
    }

    panelEl.replaceChildren(
      h('div', { className: 'notes-ws-head' }, h('span', { className: 'notes-ws-title' }, '💬 Comments')),
      h('div', { className: 'notes-ws-comment-new' }, input, addBtn),
      roots.length === 0
        ? h('div', { className: 'notes-ws-empty' }, 'No comments yet. Start a discussion about this note.')
        : h('div', { className: 'notes-ws-list' },
            ...roots.map((root) => h('div', { className: 'notes-ws-thread' },
              renderComment(root, true),
              ...(repliesByThread.get(root.threadId) ?? []).map((r) => renderComment(r, false)),
              h('div', { className: 'notes-ws-reply' }, (() => {
                const ri = h('input', { className: 'notes-ws-reply-input', type: 'text', placeholder: 'Reply…' }) as HTMLInputElement;
                ri.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { const v = ri.value; ri.value = ''; void post(v, root.id); } });
                return ri;
              })()),
            )),
          ),
    );
  }

  return { refresh, close: () => { closed = true; } };
}

// ── Synced blocks (transclusion) ────────────────────────────────────────────────

interface SyncedView { id: string; sourceNoteId: string; sourceTitle: string; sourceBlockIndex: number | null; markdown: string; available: boolean }
interface NoteListItem { id: string; title: string }

export function wireNoteSynced(opts: { noteId: string; panelEl: HTMLElement }): SimplePanel {
  const { noteId, panelEl } = opts;
  let closed = false;

  async function refresh(): Promise<void> {
    if (closed) return;
    let synced: SyncedView[] = [];
    let notesList: NoteListItem[] = [];
    try {
      const [sr, nr] = await Promise.all([api.get(`/api/me/notes/${noteId}/synced`), api.get('/api/me/notes')]);
      if (sr.ok) synced = (await sr.json() as { synced: SyncedView[] }).synced;
      if (nr.ok) notesList = ((await nr.json() as { notes: NoteListItem[] }).notes).filter((n) => n.id !== noteId);
    } catch { /* */ }
    if (closed) return;

    const select = h('select', { className: 'notes-ws-select' },
      h('option', { value: '' }, '— choose a note to sync —'),
      ...notesList.map((n) => h('option', { value: n.id }, n.title || '(untitled)')),
    ) as HTMLSelectElement;
    const addBtn = h('button', {
      className: 'notes-ws-action',
      onClick: async () => { if (!select.value) return; await api.post(`/api/me/notes/${noteId}/synced`, { sourceNoteId: select.value }).catch(() => undefined); await refresh(); },
    }, '+ Sync block');

    panelEl.replaceChildren(
      h('div', { className: 'notes-ws-head' }, h('span', { className: 'notes-ws-title' }, '🔁 Synced blocks')),
      h('div', { className: 'notes-ws-synced-new' }, select, addBtn),
      synced.length === 0
        ? h('div', { className: 'notes-ws-empty' }, 'No synced blocks. Mirror a paragraph from another note here — it stays in sync.')
        : h('div', { className: 'notes-ws-list' },
            ...synced.map((s) => h('div', { className: `notes-ws-synced${s.available ? '' : ' unavailable'}` },
              h('div', { className: 'notes-ws-synced-head' },
                h('span', { className: 'notes-ws-synced-src' }, `🔁 ${s.sourceTitle}${s.sourceBlockIndex != null ? ` · block ${s.sourceBlockIndex + 1}` : ''}`),
                h('button', { className: 'notes-ws-link', onClick: async () => { await api.del(`/api/me/notes/${noteId}/synced/${s.id}`).catch(() => undefined); await refresh(); } }, '✕'),
              ),
              h('div', { className: 'notes-ws-synced-body' }, s.markdown),
            )),
          ),
    );
  }

  return { refresh, close: () => { closed = true; } };
}

// ── Ask your workspace (RAG search box, for the notes list) ──────────────────────

interface CitedSource { n: number; id: string; kind: string; title: string; snippet: string }

export function renderWorkspaceAsk(onOpenNote: (id: string) => void): HTMLElement {
  const results = h('div', { className: 'notes-ws-ask-results' }) as HTMLElement;
  const input = h('input', { className: 'notes-ws-ask-input', type: 'text', placeholder: '✦ Ask your workspace — "what did we learn about…"' }) as HTMLInputElement;
  let busy = false;

  async function ask(): Promise<void> {
    const query = input.value.trim();
    if (!query || busy) return;
    busy = true;
    results.replaceChildren(h('div', { className: 'notes-ws-loading' }, 'Searching your notes + chats…'));
    try {
      const res = await api.post('/api/me/workspace/search', { query });
      const data = await res.json().catch(() => ({ sources: [] })) as { sources: CitedSource[] };
      if (data.sources.length === 0) {
        results.replaceChildren(h('div', { className: 'notes-ws-empty' }, 'No matches. Try the ↻ Reindex button, or add more notes.'));
      } else {
        results.replaceChildren(
          h('div', { className: 'notes-ws-ask-label' }, `${data.sources.length} source${data.sources.length === 1 ? '' : 's'} found — click to open:`),
          ...data.sources.map((s) => h('div', {
            className: 'notes-ws-ask-hit',
            ...(s.kind === 'note' ? { onClick: () => onOpenNote(s.id) } : {}),
          },
            h('div', { className: 'notes-ws-ask-hit-head' }, h('span', { className: 'notes-ws-ask-n' }, `[${s.n}]`), h('span', { className: 'notes-ws-ask-kind' }, s.kind), h('span', { className: 'notes-ws-ask-title' }, s.title)),
            h('div', { className: 'notes-ws-ask-snippet' }, s.snippet),
          )),
        );
      }
    } catch { results.replaceChildren(h('div', { className: 'notes-ws-empty' }, 'Search failed.')); }
    finally { busy = false; }
  }

  input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') void ask(); });
  const reindexBtn = h('button', { className: 'notes-ws-link', title: 'Index recent chats so they are searchable', onClick: async () => { await api.post('/api/me/workspace/reindex', {}).catch(() => undefined); void ask(); } }, '↻ Reindex');

  return h('div', { className: 'notes-ws-ask' },
    h('div', { className: 'notes-ws-ask-bar' }, input, h('button', { className: 'notes-ws-action', onClick: () => void ask() }, 'Ask'), reindexBtn),
    results,
  );
}
