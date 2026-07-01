/**
 * notes-view.ts — WC6-WC9 Notes full-page view
 *
 * Renders state.view === 'notes' with three sub-views:
 *   • list     — filterable note list (favourites pinned, sub-page tree)
 *   • editor   — open note with Tiptap editor island (WC6), backlinks panel (WC7)
 *   • templates— template gallery for WC7
 *
 * Integrations:
 *   • WC7: Favourites marked with ★; sub-page nesting via parent_note_id
 *   • WC8: "Extract to-dos" button calls POST /api/me/notes/:id/extract
 *   • WC9: "Add database view" button creates a saved filter view
 *
 * Data loaders:
 *   loadNotesList()   — fills state.notesItems
 *   loadNote(id)      — fills state.currentNote (with doc_json)
 *   saveNote(id, doc) — PATCH /api/me/notes/:id
 *   extractNote(id)   — POST /api/me/notes/:id/extract
 */

import { h } from './dom.js';
import { state, type NoteListItem, type NoteDoc } from './state.js';
import { api } from './api.js';
import { mountNotesEditor, type EditorInstance } from './notes-editor.js';
import { wireNoteCoedit, createNoteShareLink, type NoteCoeditSession } from './notes-coedit.js';
import { wireNoteAi, type NoteAiPanel } from './notes-ai.js';
import { wireSelectionCard, type SelectionCard } from './notes-ai-card.js';
import { wireLiveCursors, peerColor, type LiveCursors, type Participant } from './notes-cursors.js';
import { wireNoteConnections, type NoteConnectionsPanel } from './notes-graph.js';
import { wireProactiveLinks, type ProactiveLinksBar } from './notes-proactive-links.js';
import { renderDatabasesView } from './notes-database-view.js';
import { renderStudyView } from './notes-study.js';
import { renderTranslateCard } from './notes-translate.js';
import { renderGovernanceCard } from './notes-governance.js';
import { renderScheduledAgentsPanel } from './notes-scheduled-agents.js';
import { renderMeetingRecorder, wireMeetingTranscript } from './notes-meeting.js';
import { renderMemoryPanel, wireMemoryStrip, type MemoryStrip } from './notes-memory.js';
import { renderMcpPanel } from './notes-mcp.js';
import { renderCapturePanel } from './notes-capture.js';
import { saveNotesSnapshot, cacheNote, offlineNotes, offlineNote, setLastNoteId, getLastNoteId } from './notes-offline.js';
import { openQuickCaptureModal } from './notes-quick-capture.js';
import { wireNoteHistory, wireNoteComments, wireNoteSynced, renderWorkspaceAsk, highlightQuoteInEditor, type SimplePanel } from './notes-workspace-ui.js';
import { renderEditorCanvas, type OverflowItem } from './notes-editor-canvas.js';
import { renderRightRail } from './notes-right-rail.js';
import { renderLeftRail } from './notes-left-rail.js';
import { wovenMarkSvg } from './notes-brand.js';

/** The live co-editing session for the currently-open note (Phase 2). */
let _activeCoedit: NoteCoeditSession | null = null;
/** The AI co-author panel for the currently-open note (Phase 3). */
let _activeAi: NoteAiPanel | null = null;
/** The floating AI selection card for the currently-open note (Phase 2). */
let _activeCard: SelectionCard | null = null;
/** The live collaborative cursors for the currently-open note (Phase 3). */
let _activeCursors: LiveCursors | null = null;
/** The knowledge-graph connections panel for the currently-open note (Phase 5). */
let _activeConn: NoteConnectionsPanel | null = null;
/** The live proactive-linking bar for the currently-open note (Phase 3). */
let _activeProactive: ProactiveLinksBar | null = null;
/** Clickable transcript-citation wiring for a meeting note (Phase 4). */
let _activeMeeting: { destroy: () => void } | null = null;
/** Proactive "from your memory" strip for the currently-open note (Phase 5). */
let _activeMemory: MemoryStrip | null = null;
/** Phase 8 panels: version history, comments, synced blocks. */
let _activeHistory: SimplePanel | null = null;
let _activeComments: SimplePanel | null = null;
let _activeSynced: SimplePanel | null = null;
function teardownCoedit(): void {
  if (_activeCoedit) { _activeCoedit.close(); _activeCoedit = null; }
  if (_activeAi) { _activeAi.close(); _activeAi = null; }
  if (_activeCard) { _activeCard.destroy(); _activeCard = null; }
  if (_activeCursors) { _activeCursors.destroy(); _activeCursors = null; }
  if (_activeConn) { _activeConn.close(); _activeConn = null; }
  if (_activeProactive) { _activeProactive.destroy(); _activeProactive = null; }
  if (_activeMeeting) { _activeMeeting.destroy(); _activeMeeting = null; }
  if (_activeMemory) { _activeMemory.destroy(); _activeMemory = null; }
  if (_activeHistory) { _activeHistory.close(); _activeHistory = null; }
  if (_activeComments) { _activeComments.close(); _activeComments = null; }
  if (_activeSynced) { _activeSynced.close(); _activeSynced = null; }
}

// ── Data loaders ──────────────────────────────────────────────────────────────

export async function loadNotesList(opts?: { search?: string }): Promise<void> {
  state.notesLoading = true;
  try {
    // Fetch ALL notes (no parent filter) so the rail can render the notebook FOLDER TREE — top-level notes
    // are notebooks and sub-notes (parent_note_id) nest underneath. (Previously this filtered to roots only.)
    const params = new URLSearchParams({ limit: '500' });
    if (opts?.search) params.set('search', opts.search);
    if (state.notesSearch) params.set('search', state.notesSearch as string);
    const res = await api.get(`/api/me/notes?${params}`);
    if (!res.ok) return;
    const { notes } = await res.json() as { notes: NoteListItem[] };
    state.notesItems = notes;
    (state as { notesOffline?: boolean }).notesOffline = false;
    // Phase 8: mirror the list into the offline cache so the desktop app can launch + list with no network.
    saveNotesSnapshot(notes as Array<{ id: string }>);
  } catch (e) {
    // Phase 8: offline (or the server is unreachable) → hydrate the list from the local snapshot.
    const cached = offlineNotes();
    if (cached.length > 0) {
      state.notesItems = cached as unknown as NoteListItem[];
      (state as { notesOffline?: boolean }).notesOffline = true;
    } else {
      console.warn('[notes-view] loadNotesList error', e);
    }
  } finally {
    state.notesLoading = false;
  }
}

export async function loadNoteTemplates(): Promise<void> {
  try {
    const res = await api.get('/api/me/notes/templates');
    if (!res.ok) return;
    const { templates } = await res.json() as { templates: NoteListItem[] };
    state.noteTemplates = templates;
  } catch { /* silent */ }
}

// Per-note column layout (1–3), persisted in localStorage so the choice survives reloads without a
// schema change. Clamped to the valid range; falls back to 1 (single column) when unset or unavailable.
function readNoteColumns(id: string): number {
  try { const v = parseInt(localStorage.getItem(`gw.note.cols.${id}`) ?? '1', 10); return v >= 1 && v <= 3 ? v : 1; } catch { return 1; }
}
function writeNoteColumns(id: string, n: number): void {
  try { localStorage.setItem(`gw.note.cols.${id}`, String(Math.max(1, Math.min(3, n)))); } catch { /* storage unavailable */ }
}

export async function loadNote(id: string): Promise<void> {
  try {
    const res = await api.get(`/api/me/notes/${id}`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const note = await res.json() as NoteDoc;
    state.currentNote = note;
    state.currentNoteId = note.id;
    // weaveNotes Phase 1: adopt the note's persisted page theme (spec §10.6).
    const theme = (note as { page_theme?: string }).page_theme;
    state.notesTheme = theme === 'creative' ? 'creative' : 'pro';
    // Phase 8: remember this as the last-opened note + cache its content for offline reopening.
    setLastNoteId(note.id);
    cacheNote(note as { id: string });
    (state as { notesOffline?: boolean }).notesOffline = false;
  } catch (e) {
    // Phase 8: offline → open the note from the local cache instead of failing.
    const cached = offlineNote(id);
    if (cached) {
      state.currentNote = cached as unknown as NoteDoc;
      state.currentNoteId = cached.id;
      setLastNoteId(cached.id);
      (state as { notesOffline?: boolean }).notesOffline = true;
    } else {
      console.warn('[notes-view] loadNote error', e);
    }
  }
}

/**
 * weaveNotes Phase 8 (desktop): open the LAST note the user had open — the "launches offline and opens
 * to last note" behaviour. Reads the persisted last-note id (from the server, or the offline cache).
 * Returns true if a note was opened.
 */
export async function openLastNote(render: () => void): Promise<boolean> {
  const id = getLastNoteId();
  if (!id) return false;
  await loadNote(id);
  if (state.currentNoteId === id) { state.notesView = 'editor'; render(); return true; }
  return false;
}

async function saveNote(id: string, docJson: string, title?: string): Promise<void> {
  try {
    const body: Record<string, unknown> = { doc_json: docJson };
    if (title !== undefined) body['title'] = title;
    await api.patch(`/api/me/notes/${id}`, body);
  } catch (e) {
    console.warn('[notes-view] saveNote error', e);
  }
}

/** weaveNotes Phase 1: persist the per-note page theme (the Pro ↔ Creative toggle). */
async function saveNoteTheme(id: string, theme: 'pro' | 'creative'): Promise<void> {
  try { await api.patch(`/api/me/notes/${id}`, { page_theme: theme }); }
  catch (e) { console.warn('[notes-view] saveNoteTheme error', e); }
}

async function createNote(template?: { id?: string; key?: string | null; parentNoteId?: string }): Promise<NoteListItem | null> {
  try {
    const body: Record<string, unknown> = {};
    // Phase 6: prefer the stable template KEY (system templates); fall back to a note id.
    // When a template is chosen, omit the title so the server adopts the template's name.
    if (template?.key) body['template_key'] = template.key;
    else if (template?.id) body['template_id'] = template.id;
    else body['title'] = 'Untitled';
    // Notebook folders: create the note nested under a parent notebook when asked.
    if (template?.parentNoteId) body['parent_note_id'] = template.parentNoteId;
    const res = await api.post('/api/me/notes', body);
    if (!res.ok) return null;
    return res.json() as Promise<NoteListItem>;
  } catch {
    return null;
  }
}

// ── weaveNotes Phase 6: archive / trash ────────────────────────────────────────

async function loadArchivedNotes(): Promise<void> {
  try {
    const res = await api.get('/api/me/notes?archived=1');
    if (!res.ok) return;
    const { notes } = await res.json() as { notes: NoteListItem[] };
    state.notesArchived = notes;
  } catch { /* silent */ }
}

async function archiveNote(id: string): Promise<boolean> {
  try { return (await api.post(`/api/me/notes/${id}/archive`, {})).ok; } catch { return false; }
}

async function restoreNote(id: string): Promise<boolean> {
  try { return (await api.post(`/api/me/notes/${id}/restore`, {})).ok; } catch { return false; }
}

async function deleteNote(id: string): Promise<boolean> {
  try {
    const res = await api.del(`/api/me/notes/${id}`);
    return res.ok;
  } catch {
    return false;
  }
}

async function toggleFavorite(note: NoteListItem): Promise<void> {
  try {
    await api.put(`/api/me/notes/${note.id}`, { favorite: note.favorite ? 0 : 1 });
  } catch { /* silent */ }
}

async function extractNote(id: string): Promise<{ extractedTasks: Array<{ id: string; title: string }> } | null> {
  try {
    const res = await api.post(`/api/me/notes/${id}/extract`, {});
    if (!res.ok) return null;
    return res.json() as Promise<{ extractedTasks: Array<{ id: string; title: string }> }>;
  } catch {
    return null;
  }
}

// ── Active editor instance (singleton per open note) ──────────────────────────
let _activeEditor: EditorInstance | null = null;

function destroyActiveEditor(): void {
  _activeEditor?.destroy();
  _activeEditor = null;
  teardownCoedit(); // also leave the live co-editing room (Phase 2)
}

// ── Templates gallery ─────────────────────────────────────────────────────────

// The design's gallery groups templates by purpose, in this reading order (spec §7).
const TEMPLATE_CATEGORY_ORDER = ['Blank', 'Study', 'Meetings', 'Planning', 'Thinking'] as const;

function renderTemplatesGallery(render: () => void): HTMLElement {
  const templates: NoteListItem[] = state.noteTemplates ?? [];

  const startFrom = async (tmpl: NoteListItem): Promise<void> => {
    const note = await createNote({ key: tmpl.key ?? tmpl.template_key, id: tmpl.id });
    if (note) {
      state.notesItems = [note as NoteListItem, ...(state.notesItems as NoteListItem[])];
      await loadNote(note.id);
      state.notesView = 'editor';
      render();
    }
  };

  const card = (tmpl: NoteListItem): HTMLElement =>
    h('div', { className: 'notes-template-card', title: tmpl.description || tmpl.title, onClick: () => void startFrom(tmpl) },
      h('div', { className: 'notes-template-icon' }, tmpl.icon ?? '📄'),
      h('div', { className: 'notes-template-title' }, tmpl.title),
      tmpl.description ? h('div', { className: 'notes-template-desc' }, tmpl.description) : null,
    );

  // Group by category, in the design's order; unknown categories fall to the end.
  const groups = new Map<string, NoteListItem[]>();
  for (const t of templates) {
    const cat = t.category || 'Blank';
    (groups.get(cat) ?? (groups.set(cat, []), groups.get(cat)!)).push(t);
  }
  const orderedCats = [
    ...TEMPLATE_CATEGORY_ORDER.filter((c) => groups.has(c)),
    ...[...groups.keys()].filter((c) => !TEMPLATE_CATEGORY_ORDER.includes(c as typeof TEMPLATE_CATEGORY_ORDER[number])),
  ];

  return h('div', { className: 'notes-templates' },
    h('div', { className: 'notes-templates-header' },
      h('button', { className: 'notes-back-btn', onClick: () => { state.notesView = 'list'; render(); } }, '← Notes'),
      h('div', { className: 'notes-templates-title' }, 'Templates'),
      h('div', { className: 'notes-templates-sub' }, 'Start a note from a ready-made layout.'),
    ),
    templates.length === 0
      ? h('div', { className: 'notes-empty' }, 'No templates available')
      : h('div', { className: 'notes-templates-cats' },
          ...orderedCats.map((cat) =>
            h('section', { className: 'notes-template-cat' },
              h('div', { className: 'notes-template-cat-label' }, cat),
              h('div', { className: 'notes-template-grid' }, ...(groups.get(cat) ?? []).map(card)),
            )
          ),
        ),
  );
}

// ── weaveNotes Phase 6: the Archived / trash view ──────────────────────────────

function renderArchiveView(render: () => void): HTMLElement {
  const archived: NoteListItem[] = state.notesArchived ?? [];

  const row = (note: NoteListItem): HTMLElement =>
    h('div', { className: 'notes-archive-row' },
      h('span', { className: 'notes-archive-icon' }, note.icon ?? '📄'),
      h('span', { className: 'notes-archive-title' }, note.title || 'Untitled'),
      h('button', { className: 'notes-archive-restore', title: 'Restore to your notes', onClick: async () => {
          if (await restoreNote(note.id)) { await loadArchivedNotes(); await loadNotesList(); render(); }
        } }, '↩ Restore'),
      h('button', { className: 'notes-archive-delete', title: 'Delete permanently', onClick: async () => {
          if (!confirm('Permanently delete this note? This cannot be undone.')) return;
          if (await deleteNote(note.id)) { await loadArchivedNotes(); render(); }
        } }, '🗑 Delete forever'),
    );

  return h('div', { className: 'notes-archive' },
    h('div', { className: 'notes-templates-header' },
      h('button', { className: 'notes-back-btn', onClick: () => { state.notesView = 'list'; render(); } }, '← Notes'),
      h('div', { className: 'notes-templates-title' }, 'Archived notes'),
      h('div', { className: 'notes-templates-sub' }, 'Archived notes are hidden from your notebooks but can be restored anytime.'),
    ),
    archived.length === 0
      ? h('div', { className: 'notes-empty' }, 'Nothing archived. Notes you archive will appear here.')
      : h('div', { className: 'notes-archive-list' }, ...archived.map(row)),
  );
}

// ── "+ Insert" menu (the secondary creators, kept out of the calm left rail) ──────

/** A lightweight centred modal overlay holding an arbitrary widget. */
function openCenterModal(title: string, body: HTMLElement): void {
  const overlay = h('div', { className: 'gw-modal-overlay', onClick: (e: Event) => { if (e.target === overlay) overlay.remove(); } },
    h('div', { className: 'gw-modal' },
      h('div', { className: 'gw-modal-head' }, h('span', null, title), h('button', { className: 'gw-modal-x', onClick: () => overlay.remove() }, '×')),
      body,
    ),
  ) as HTMLElement;
  document.body.appendChild(overlay);
}

// weaveNotes Phase 10 — note export (download in a chosen format).
const EXPORT_OPTIONS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'markdown', label: 'Markdown (.md)', hint: 'Portable plain-text with formatting' },
  { key: 'html', label: 'Web page (.html)', hint: 'Self-contained — Print → Save as PDF for a PDF' },
  { key: 'word', label: 'Word (.doc)', hint: 'Opens in Microsoft Word / Google Docs' },
  { key: 'json', label: 'Lossless backup (.json)', hint: 'Re-importable — nothing is lost' },
];

/** Fetch a note export from the server and trigger a browser download. */
async function downloadNoteExport(noteId: string, format: string): Promise<boolean> {
  try {
    const res = await api.get(`/api/me/notes/${noteId}/export?format=${encodeURIComponent(format)}`);
    if (!res.ok) return false;
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') ?? '';
    const m = cd.match(/filename="(.+?)"/);
    const filename = m?.[1] ?? `note.${format}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch { return false; }
}

/** Open the export picker — a format menu that downloads the note when a format is clicked. */
function openExportMenu(note: NoteDoc): void {
  const body = h('div', { className: 'gw-export-menu' },
    h('div', { className: 'gw-export-sub' }, 'Download a copy of this note:'),
    ...EXPORT_OPTIONS.map((opt) =>
      h('button', { className: 'gw-export-opt', 'data-format': opt.key, onClick: async () => {
          const ok = await downloadNoteExport(note.id, opt.key);
          if (!ok) alert('Could not export this note.');
          else document.querySelector('.gw-modal-overlay')?.remove();
        } },
        h('span', { className: 'gw-export-opt-label' }, opt.label),
        h('span', { className: 'gw-export-opt-hint' }, opt.hint),
      ),
    ),
  );
  openCenterModal('⬇ Export note', body);
}

function buildInsertMenu(render: () => void): OverflowItem[] {
  const openNote = async (id: string): Promise<void> => { await loadNote(id); state.notesView = 'editor'; render(); };
  return [
    { label: '📝 New note', title: 'Create a blank note', onClick: async () => { const n = await createNote(); if (n) { state.notesItems = [n as NoteListItem, ...(state.notesItems as NoteListItem[])]; await openNote(n.id); } } },
    { label: '⚡ Quick capture', title: 'Jot a quick note (⌘/Ctrl+Shift+K)', onClick: () => { openQuickCaptureModal((id) => { void openNote(id); }); } },
    { label: '⊞ New from template', title: 'Start from a template', onClick: async () => { await loadNoteTemplates(); state.notesView = 'templates'; render(); } },
    { label: '🎙 Record meeting', title: 'Record → transcribe → a structured note with clickable transcript citations', onClick: () => {
        openCenterModal('Record a meeting', renderMeetingRecorder((id) => { void loadNotesList().then(() => openNote(id)); }));
      } },
    { label: '🧠 Your memory', title: 'See + search everything the app remembers about you from your notes (your "second brain")', onClick: () => {
        openCenterModal('Your memory', renderMemoryPanel((id) => { void openNote(id); }));
      } },
    { label: '🌐 Capture a web page', title: 'Clip a public page into a note', onClick: async () => {
        const url = prompt('Paste a public web page URL to clip into a note:'); if (!url) return;
        const res = await api.post('/api/me/notes/capture/web', { url }).catch(() => null);
        const data = res && res.ok ? await res.json().catch(() => ({})) as { noteId?: string } : null;
        if (data?.noteId) { await loadNotesList(); await openNote(data.noteId); } else { alert('Could not clip that page.'); }
      } },
    { label: '✦ Ask your workspace', title: 'Search your notes + chats with citations', onClick: () => {
        openCenterModal('Ask your workspace', renderWorkspaceAsk((id, quote) => {
          void (async () => {
            await openNote(id);
            document.querySelector('.gw-modal-overlay')?.remove();
            // After the editor renders, highlight the exact cited line in the source note.
            if (quote) setTimeout(() => highlightQuoteInEditor(quote), 450);
          })();
        }));
      } },
    { label: '🗃 Databases', title: 'Tables with AI auto-fill', onClick: () => { state.currentDatabaseId = null; state.notesView = 'databases'; render(); } },
    { label: '📇 Study (flashcards)', title: 'Make + review flashcards from this note (spaced repetition)', onClick: () => { teardownCoedit(); state.notesView = 'study'; render(); } },
    { label: '🌍 Translate', title: 'Translate this note into another language (saved as a new note)', onClick: () => {
        const id = state.currentNoteId as string | null;
        if (!id) { alert('Open a note first, then translate it.'); return; }
        openCenterModal('Translate note', renderTranslateCard(id, (newId) => { void openNote(newId); }));
      } },
    { label: '📥 Archived notes', title: 'View + restore archived notes', onClick: async () => { await loadArchivedNotes(); state.notesView = 'archive'; render(); } },
    { label: '🛡️ Workspace governance', title: 'See your workspace’s enterprise trust posture (read-only)', onClick: () => { openCenterModal('Workspace governance', renderGovernanceCard()); } },
    { label: '⏰ Scheduled agents', title: 'Set up recurring AI tasks over your notes (e.g. a daily digest)', onClick: () => { openCenterModal('Scheduled agents', renderScheduledAgentsPanel((id) => { void openNote(id); })); } },
    { label: '🔌 Connect (MCP)', title: 'Let an outside AI app (Claude, ChatGPT) use your notes via MCP', onClick: () => { openCenterModal('Connect an external app (MCP)', renderMcpPanel()); } },
  ];
}

// ── Editor panel ──────────────────────────────────────────────────────────────

/** The right-rail Assistant tab (module-local so it survives editor re-renders). */
let _railTab: 'assistant' | 'outline' | 'links' = 'assistant';

function renderEditorPanel(note: NoteDoc, render: () => void): { center: HTMLElement; rail: HTMLElement } {
  const isFav = note.favorite === 1;
  const creative = (state.notesTheme as string) === 'creative';
  let editorMounted = false;
  let extractResult: string | null = null;

  const titleInput = h('input', {
    className: 'notes-title-input',
    type: 'text',
    value: note.title,
    placeholder: 'Untitled',
    onBlur: async () => {
      await saveNote(note.id, JSON.stringify((state.currentNote as NoteDoc | null)?.doc_json ?? '{}'), titleInput.value);
    },
    onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') titleInput.blur(); },
  }) as HTMLInputElement;

  const editorContainer = h('div', { className: 'notes-editor-mount' });

  // weaveNotes Phase 3 — AI co-author: a toolbar (Continue / Rewrite / Summarize /
  // Ask / +AI block) and a panel listing pending track-changes suggestions to review.
  const aiToolbar = h('div', { className: 'notes-ai-toolbar-mount' }) as HTMLElement;
  const aiPanel = h('div', { className: 'notes-ai-panel', style: 'display:none' }) as HTMLElement;

  // weaveNotes Phase 5 — the knowledge-graph "Connections" panel (backlinks, unlinked
  // mentions, related notes, mini graph). Lives in the right rail's "Links" tab.
  const connPanel = h('div', { className: 'notes-connections-panel' }) as HTMLElement;

  // weaveNotes Phase 3 — the live proactive-linking bar (sits above the note body, hidden until
  // there's an unlinked mention to connect; one-click turns it into a [[wiki-link]]).
  const proactiveBar = h('div', { className: 'notes-proactive-bar', style: 'display:none' }) as HTMLElement;
  // weaveNotes Phase 5 — the proactive "from your memory" strip (durable things you told the app
  // before that relate to what you're writing now). Hidden until there's something to recall.
  const memoryStrip = h('div', { className: 'notes-memory-strip', style: 'display:none' }) as HTMLElement;

  // weaveNotes Phase 8 — version History, Comments, and Synced-blocks panels. Inline panels
  // shown above the editor, toggled from the centre top-bar overflow (⋯) menu.
  const historyPanel = h('div', { className: 'notes-ws-panel' }) as HTMLElement; historyPanel.style.display = 'none';
  const commentsPanel = h('div', { className: 'notes-ws-panel' }) as HTMLElement; commentsPanel.style.display = 'none';
  const syncedPanel = h('div', { className: 'notes-ws-panel' }) as HTMLElement; syncedPanel.style.display = 'none';
  // A generic toggle for an inline panel: flip visibility + refresh its wired controller when shown.
  const togglePanel = (panel: HTMLElement, refresh?: () => void): void => {
    const show = panel.style.display === 'none';
    panel.style.display = show ? '' : 'none';
    if (show) refresh?.();
  };

  // weaveNotes Phase 2 — collaborative co-editing UI bits.
  // A live "N editing" badge, a "refresh" nudge shown when a collaborator edits
  // while you're typing, and a Share button that mints an invite link.
  let lastLocalEditTs = 0;
  let _saveChain: Promise<void> = Promise.resolve(); // serializes overlapping debounced saves (last-wins)
  let mountTs = 0;
  const presenceBadge = h('span', { className: 'notes-presence-badge', title: 'People editing this note', style: 'display:none' }) as HTMLElement;
  // Phase 3: live participant avatars (a coloured circle per person, the woven mark for the AI).
  const presenceAvatarsEl = h('span', { className: 'gw-presence-avatars' }) as HTMLElement;
  const renderAvatars = (list: Participant[]): void => {
    presenceAvatarsEl.innerHTML = '';
    for (const p of list.slice(0, 6)) {
      if (p.peerType === 'ai') {
        presenceAvatarsEl.appendChild(h('span', { className: 'gw-avatar gw-avatar-ai', title: p.name, innerHTML: wovenMarkSvg(13, 'ai') }));
      } else {
        const initial = (p.name || '?').trim().charAt(0).toUpperCase() || '?';
        presenceAvatarsEl.appendChild(h('span', { className: 'gw-avatar gw-avatar-live', title: p.name, style: `background:${p.color}` }, initial));
      }
    }
  };
  let peerCount = 1;
  const updatePresence = (count: number): void => {
    peerCount = count;
    if (count > 1) { presenceBadge.textContent = `● ${count} editing`; presenceBadge.style.display = ''; }
    else { presenceBadge.style.display = 'none'; }
  };
  // A remote edit arrived. Only surface the "updated" nudge when there is ACTUALLY another
  // editor present — a solo author only ever sees their own op echoed back, which is not a
  // collaborator edit. (Also ignore the first ~1.5s while the seed op replays on join.)
  const onRemoteChange = (): void => {
    if (Date.now() - mountTs < 1500) return; // ignore the seed-op replay on join
    // Defer a reconcile while an edit is in flight: either you are actively typing in the editor,
    // OR a local edit happened very recently but hasn't saved yet (e.g. a diagram/ink toolbar button,
    // which edits the doc WITHOUT focusing the contenteditable). Without the second clause a remote
    // echo arriving in the 1.5s save window would reload + clobber the unsaved edit.
    const typingNow = Date.now() - lastLocalEditTs < 2500;
    // Reconcile silently when idle; while you are mid-keystroke, defer until you pause (no
    // intrusive banner — the design has none, and a solo author only sees their own echo).
    if (!typingNow) { void loadNote(note.id).then(render); }
    void peerCount;
  };
  const shareBtn = h('button', {
    className: 'notes-share-btn', title: 'Share this note for co-editing',
    onClick: async () => {
      const link = await createNoteShareLink(note.id, 'collaborator');
      if (!link) { alert('Could not create a share link.'); return; }
      try { await navigator.clipboard.writeText(link.url); } catch { /* clipboard may be blocked */ }
      prompt('Share this co-editing link (copied to clipboard):', link.url);
    },
  }, '🔗 Share') as HTMLElement;

  // weaveNotes Phase 4 — publish the note as a shareable artifact (a public, read-only
  // document link). A `restricted` note is refused; secrets/PII are redacted server-side.
  const publishBtn = h('button', {
    className: 'notes-publish-btn', title: 'Publish this note as a shareable document',
    onClick: async () => {
      publishBtn.setAttribute('disabled', 'true');
      try {
        const res = await api.post(`/api/me/notes/${note.id}/emit-artifact`, { format: 'markdown', share: true });
        const data = await res.json().catch(() => ({})) as { ok?: boolean; shareUrl?: string; error?: string; redactions?: number };
        if (!res.ok || !data.ok) { alert(`Could not publish: ${data.error ?? res.status}`); return; }
        const redactionNote = data.redactions ? `\n\n(${data.redactions} sensitive item(s) were redacted before publishing.)` : '';
        if (data.shareUrl) { try { await navigator.clipboard.writeText(data.shareUrl); } catch { /* blocked */ } }
        prompt(`Published! Public link (copied to clipboard):${redactionNote}`, data.shareUrl ?? '(no link)');
      } finally { publishBtn.removeAttribute('disabled'); }
    },
  }, '📤 Publish') as HTMLElement;

  const iconEl = h('span', {
    className: 'notes-editor-icon',
    title: 'Set icon',
    onClick: async () => {
      const newIcon = prompt('Enter emoji for note icon (e.g. 📝):', note.icon ?? '📄');
      if (newIcon !== null) {
        await api.put(`/api/me/notes/${note.id}`, { icon: newIcon });
        note.icon = newIcon;
        iconEl.textContent = newIcon || '📄';
      }
    },
  }, note.icon ?? '📄');

  // — the secondary actions live in the centre top-bar overflow (⋯) menu —
  const overflow: OverflowItem[] = [
    { label: isFav ? '★ Unfavourite' : '☆ Favourite', title: 'Favourite', onClick: async () => { await api.put(`/api/me/notes/${note.id}`, { favorite: isFav ? 0 : 1 }); note.favorite = isFav ? 0 : 1; render(); } },
    { label: '📜 Version history', title: 'Save points + restore', onClick: () => togglePanel(historyPanel, () => void _activeHistory?.refresh()) },
    { label: '💬 Comments', title: 'Discussion threads on this note', onClick: () => togglePanel(commentsPanel, () => void _activeComments?.refresh()) },
    { label: '🔁 Synced blocks', title: 'Mirror content from another note', onClick: () => togglePanel(syncedPanel, () => void _activeSynced?.refresh()) },
    { label: '🔗 Share', title: 'Share for co-editing', onClick: async () => {
        const link = await createNoteShareLink(note.id, 'collaborator');
        if (!link) { alert('Could not create a share link.'); return; }
        try { await navigator.clipboard.writeText(link.url); } catch { /* clipboard may be blocked */ }
        prompt('Share this co-editing link (copied to clipboard):', link.url);
      } },
    { label: '📤 Publish', title: 'Publish as a shareable document', onClick: async () => {
        const res = await api.post(`/api/me/notes/${note.id}/emit-artifact`, { format: 'markdown', share: true });
        const data = await res.json().catch(() => ({})) as { ok?: boolean; shareUrl?: string; error?: string; redactions?: number };
        if (!res.ok || !data.ok) { alert(`Could not publish: ${data.error ?? res.status}`); return; }
        const redactionNote = data.redactions ? `\n\n(${data.redactions} sensitive item(s) were redacted before publishing.)` : '';
        if (data.shareUrl) { try { await navigator.clipboard.writeText(data.shareUrl); } catch { /* blocked */ } }
        prompt(`Published! Public link (copied to clipboard):${redactionNote}`, data.shareUrl ?? '(no link)');
      } },
    { label: '⬇ Export', title: 'Download as Markdown / HTML / Word / JSON', onClick: () => openExportMenu(note) },
    { label: '⊡ Extract to-dos', title: 'Extract to-dos as tasks', onClick: async () => {
        const result = await extractNote(note.id);
        if (result) { const count = result.extractedTasks.length; extractResult = count > 0 ? `${count} task${count === 1 ? '' : 's'} created` : 'No new to-dos found'; render(); }
      } },
    { label: '📥 Archive note', title: 'Move to the archive (recoverable)', onClick: async () => {
        destroyActiveEditor();
        if (await archiveNote(note.id)) {
          state.currentNoteId = null; state.currentNote = null; state.notesView = 'list';
          await loadNotesList(); render();
        }
      } },
    { label: '🗑 Delete note', title: 'Delete note', danger: true, onClick: async () => {
        if (!confirm('Delete this note? This cannot be undone.')) return;
        destroyActiveEditor();
        await deleteNote(note.id);
        state.currentNoteId = null; state.currentNote = null; state.notesView = 'list';
        await loadNotesList(); render();
      } },
  ];

  // — formatting commands drive the live Tiptap instance via its exposed cmd() runner (no-op until it
  //   mounts). cmd() re-focuses the editor first, so a toolbar click that stole focus still applies to
  //   the right selection. (Previously this reached for a `chain` the instance never exposed → no-op.) —
  const fmt = (cmd: string, arg?: unknown): void => {
    try { _activeEditor?.cmd(cmd, arg); } catch { /* editor not ready / command unavailable */ }
  };

  // — the Assistant body for the right rail: a mint AI greeting bubble (design), then the
  //   AI co-author actions (styled as suggestion buttons) + the pending-suggestion panel —
  const assistantBody = h('div', { className: 'gw-assistant-body' },
    h('div', { className: 'gw-ai-msg' },
      h('span', { className: 'gw-ai-msg-avatar', innerHTML: wovenMarkSvg(14, 'ai') }),
      h('div', { className: 'gw-ai-msg-bubble' }, 'I can help with this note — continue your writing, rewrite a passage, summarize the page, or turn it into something new.'),
    ),
    aiToolbar,
    // The AI's proposed edits (aiPanel) render INLINE IN THE NOTE (the centre canvas), not here —
    // as the design's track-changes diff cards (accept/reject right where the change is).
  );

  // — compute the outline from the note's headings (best-effort from doc_json) —
  const outline = computeOutline(note.doc_json);

  // — CENTRE canvas (presentational module) —
  const center = renderEditorCanvas({
    breadcrumb: { notebook: 'Notes', title: note.title },
    creative,
    metaText: 'Edited just now',
    isLive: true,
    iconEl, titleInput, editorContainer, presenceBadge, presenceAvatarsEl,
    inlinePanels: [memoryStrip, proactiveBar, historyPanel, commentsPanel, syncedPanel],
    afterEditorPanels: [aiPanel], // the inline AI-edit diff cards live in the note body
    extractResult,
    onSetTheme: (t) => {
      state.notesTheme = t;
      if (state.currentNote) (state.currentNote as { page_theme?: string }).page_theme = t;
      void saveNoteTheme(note.id, t);
      render();
    },
    onAskAi: () => { _railTab = 'assistant'; render(); },
    // Column layout (1–3): the design's board control. Persisted per note in localStorage (no migration),
    // applied to the editor body via `data-cols` on the canvas.
    columns: readNoteColumns(note.id),
    onSetColumns: (n: number) => { writeNoteColumns(note.id, n); render(); },
    // Account avatar → the profile/settings surface (Notes is full-bleed with no global nav).
    onAccount: () => { state.view = 'account'; state.accountSection = 'profile'; render(); },
    userInitial: (((state.user as { name?: string } | null)?.name || 'You').trim()[0] || 'Y').toUpperCase(),
    format: {
      bold: () => fmt('toggleBold'), italic: () => fmt('toggleItalic'), underline: () => fmt('toggleUnderline'),
      highlight: (color) => fmt('toggleHighlight', { color }), sticker: () => fmt('setSticker', { emoji: '✨' }),
      // geneWeave Notes: the full rich-text surface, wired to the editor's existing commands so the visible
      // toolbar matches the design (headings, lists, quote/code, link, text colour, undo/redo).
      run: (cmd: string, arg?: unknown) => fmt(cmd, arg),
      textColor: (c: string) => fmt('setTextColor', c),
      link: () => {
        const url = window.prompt('Link URL (https://…)')?.trim();
        if (url === undefined) return;
        if (url === '') { fmt('unsetLink'); return; }
        const href = /^(https?:|mailto:|\/)/i.test(url) ? url : `https://${url}`;
        fmt('setLink', { href });
      },
    },
    insert: buildInsertMenu(render),
    overflow,
  });

  // — RIGHT Assistant rail (presentational module) —
  const rail = renderRightRail({
    tab: _railTab,
    onTab: (t) => { _railTab = t; if (t === 'links') void _activeConn?.refresh(); render(); },
    assistantBody,
    linksBody: connPanel,
    outline,
    onOutlineClick: () => { editorContainer.querySelector<HTMLElement>('[contenteditable]')?.focus(); },
    composerPlaceholder: 'Ask this note anything…',
    onComposerSend: async (text) => {
      try { await api.post(`/api/me/notes/${note.id}/ai/ask`, { instruction: text }); await _activeAi?.refresh(); } catch { /* surfaced in the panel */ }
    },
  });

  // Mount Tiptap after the panel DOM is attached (via requestAnimationFrame)
  requestAnimationFrame(() => {
    if (editorMounted) return;
    editorMounted = true;
    mountTs = Date.now();
    // Phase 2: join the note's live co-editing room (ensures the shared doc, opens
    // the presence/op stream). Saves route through the relay's diff-on-save so two
    // people editing the same note merge instead of clobbering.
    teardownCoedit();
    _activeCoedit = wireNoteCoedit({
      noteId: note.id, onRemoteChange, onPresence: updatePresence,
      // Phase 3: feed every peer's awareness (cursor/identity) into the live-cursors renderer.
      onAwareness: (peerId, entry) => _activeCursors?.applyAwareness(peerId, entry),
    });
    // Phase 3: wire the AI co-author toolbar + suggestion review. Accepting a
    // suggestion (or inserting/refreshing an AI block) reloads the note so the
    // editor reflects the applied change.
    _activeAi = wireNoteAi({ noteId: note.id, toolbarEl: aiToolbar, panelEl: aiPanel, onApplied: () => { void loadNote(note.id).then(render); } });
    // Phase 2: the floating AI selection card — select text → card → ask/colour → suggestion.
    _activeCard = wireSelectionCard({ container: editorContainer, noteId: note.id, onSuggestion: () => { _railTab = 'assistant'; void _activeAi?.refresh(); } });
    // Phase 5: wire the knowledge-graph connections panel (hidden until the button opens it).
    _activeConn = wireNoteConnections({ noteId: note.id, panelEl: connPanel, onOpenNote: (id) => { void loadNote(id).then(render); }, onApplied: () => { void loadNote(note.id).then(render); } });
    // Phase 3: wire the LIVE proactive-linking bar (debounced; shows as you pause typing).
    _activeProactive = wireProactiveLinks({ noteId: note.id, barEl: proactiveBar, onApplied: () => { void loadNote(note.id).then(render); } });
    void _activeProactive.refresh();
    // Phase 4: for a MEETING note, make the ⟦m:ss⟧ citation markers click-to-jump the transcript.
    _activeMeeting = wireMeetingTranscript({ noteId: note.id, editorContainer });
    // Phase 5: proactively surface durable memories relevant to this note (the "second brain").
    _activeMemory = wireMemoryStrip({ noteId: note.id, barEl: memoryStrip });
    // Phase 8: wire the version-history, comments, and synced-blocks panels (hidden until opened).
    _activeHistory = wireNoteHistory({ noteId: note.id, panelEl: historyPanel, onRestored: () => { void loadNote(note.id).then(render); } });
    _activeComments = wireNoteComments({ noteId: note.id, panelEl: commentsPanel });
    _activeSynced = wireNoteSynced({ noteId: note.id, panelEl: syncedPanel });

    mountNotesEditor({
      container: editorContainer,
      initialDocJson: note.doc_json,
      placeholder: 'Start writing… type / for commands, @ to mention',
      // Phase 3: broadcast my caret whenever it moves (the live-cursors wiring throttles it).
      onSelectionChange: () => _activeCursors?.onLocalSelectionChange(),
      // Mark an edit as pending the instant it happens (the save is debounced) so a remote-echo
      // reload can't clobber an unsaved edit that didn't focus the editor (a diagram/ink button).
      onLocalEdit: () => { lastLocalEditTs = Date.now(); _activeProactive?.noteEdited(); },
      // Serialize saves: two debounced saves >1.5s apart can otherwise overlap, and since each
      // sends the WHOLE document, a slower earlier (stale) snapshot landing after a newer one would
      // revert it (e.g. a node-add right after a recolour). Chaining guarantees in-order, last-wins.
      onSave: (docJson) => {
        lastLocalEditTs = Date.now();
        _saveChain = _saveChain.then(async () => {
          lastLocalEditTs = Date.now();
          let parsed: unknown; try { parsed = JSON.parse(docJson); } catch { parsed = undefined; }
          // Prefer the convergent relay path; fall back to the legacy save if it's unavailable.
          const merged = parsed !== undefined && _activeCoedit ? await _activeCoedit.save(parsed) : false;
          if (!merged) await saveNote(note.id, docJson);
        }).catch((e) => { console.warn('[notes-view] save failed', e); });
        return _saveChain;
      },
    }).then((inst) => {
      _activeEditor = inst;

      // Phase 3: once the editor + room are ready, wire LIVE CURSORS (if enabled for this workspace).
      void _activeCoedit?.ready.then((info) => {
        if (!info.liveCursors || !_activeCoedit) return;
        const myName = (state.user as { name?: string } | null)?.name || 'You';
        const userKey = info.siteId.split(':').slice(0, 2).join(':') || info.siteId;
        _activeCursors = wireLiveCursors({
          session: _activeCoedit, editor: inst, container: editorContainer,
          me: { name: myName, color: peerColor(userKey) }, mySiteId: info.siteId,
          onParticipants: renderAvatars,
        });
      });
    }).catch((err) => {
      editorContainer.innerHTML = `<div class="notes-editor-error">Editor failed to load: ${String(err)}</div>`;
    });
  });

  return { center, rail };
}

/** Derive a heading outline from a note's ProseMirror doc_json (best-effort). */
function computeOutline(docJson: unknown): Array<{ text: string; level: number }> {
  const out: Array<{ text: string; level: number }> = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; attrs?: { level?: number }; content?: unknown[]; text?: string };
    if (n.type === 'heading') {
      const text = (n.content ?? []).map((c) => (c as { text?: string }).text ?? '').join('');
      out.push({ text, level: Math.min(3, Math.max(1, n.attrs?.level ?? 1)) });
    }
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  try { walk(typeof docJson === 'string' ? JSON.parse(docJson) : docJson); } catch { /* */ }
  return out;
}

// ── Main notes view ───────────────────────────────────────────────────────────

export function renderNotesView(render: () => void): HTMLElement {
  const notesView = state.notesView as string;
  const currentNote = state.currentNote as NoteDoc | null;
  if (state.notesTheme === undefined) state.notesTheme = 'pro';

  // The geneWeave Notes shell is a persistent THREE-column layout (design handoff):
  //   left notebooks rail · centre canvas · right Assistant rail.
  // Databases/templates take over the centre; the right rail shows a calm empty Assistant.
  const editing = notesView === 'editor' && currentNote;
  const composed = editing ? renderEditorPanel(currentNote, render) : null;

  const centre = notesView === 'study' && currentNote
    ? renderStudyView(currentNote.id, currentNote.title || 'Untitled', () => { state.notesView = 'editor'; render(); })
    : notesView === 'databases'
    ? h('main', { className: 'gw-canvas' }, renderDatabasesView(render))
    : notesView === 'templates'
      ? h('main', { className: 'gw-canvas' }, renderTemplatesGallery(render))
      : notesView === 'archive'
      ? h('main', { className: 'gw-canvas' }, renderArchiveView(render))
      : composed
        ? composed.center
        : h('main', { className: 'gw-canvas' },
            // Mobile-only toolbar so the notebooks rail is reachable even before a note is open.
            h('div', { className: 'gw-empty-topbar' },
              h('button', { className: 'gw-rail-toggle', type: 'button', 'aria-label': 'Show notebooks',
                innerHTML: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>',
                onClick: (e: Event) => { (e.currentTarget as HTMLElement).closest('.gw-shell')?.classList.toggle('rail-open'); } })),
            h('div', { className: 'notes-select-prompt' },
              h('div', { className: 'notes-select-icon', innerHTML: wovenMarkSvg(40, 'ai') }),
              h('div', { className: 'notes-select-msg' }, 'Select a note to start editing'),
              h('div', { className: 'notes-select-sub' }, 'or create a new one with + New note'),
            ),
          );

  const rightRail = composed ? composed.rail : renderEmptyAssistantRail();

  const leftRail = renderLeftRail({
    notes: (state.notesItems as NoteListItem[]) ?? [],
    loading: state.notesLoading as boolean,
    currentNoteId: state.currentNoteId as string | null,
    search: (state.notesSearch as string) ?? '',
    onSearch: (q) => { state.notesSearch = q; void loadNotesList().then(render); },
    onOpenNote: async (id) => { destroyActiveEditor(); await loadNote(id); state.notesView = 'editor'; render(); },
    onToggleFav: async (n) => { await toggleFavorite(n); await loadNotesList(); render(); },
    onNewNote: async () => {
      const note = await createNote();
      if (note) { state.notesItems = [note as NoteListItem, ...(state.notesItems as NoteListItem[])]; await loadNote(note.id); state.notesView = 'editor'; render(); }
    },
    onTemplates: async () => { await loadNoteTemplates(); state.notesView = 'templates'; render(); },
    onArchived: async () => { await loadArchivedNotes(); state.notesView = 'archive'; render(); },
    onHome: () => { state.view = 'home'; render(); },
    onRerender: render,
    onNewSubNote: async (parentId: string) => {
      const n = await createNote({ parentNoteId: parentId });
      if (n) { await loadNotesList(); await loadNote(n.id); state.notesView = 'editor'; render(); }
    },
  });

  // weaveNotes Phase 8 (desktop): an offline banner when the list/note came from the local cache.
  const offline = (state as { notesOffline?: boolean }).notesOffline === true;
  return h('div', { className: 'gw-notes notes-full-view' },
    offline ? h('div', { className: 'gw-notes-offline', title: 'Showing your locally cached notes' },
      '✈︎ Offline — showing your cached notes. Changes will sync when you reconnect.') : null,
    h('div', { className: 'gw-shell' },
      leftRail, centre, rightRail,
      // Backdrop for the mobile rail drawer — tap to close (CSS-hidden ≥900px).
      h('div', { className: 'gw-notes-backdrop', 'aria-hidden': 'true', onClick: (e: Event) => {
        (e.currentTarget as HTMLElement).closest('.gw-shell')?.classList.remove('rail-open');
      } }),
    ),
  );
}

/** A calm right rail shown when no note is open (matches the design's empty Assistant). */
function renderEmptyAssistantRail(): HTMLElement {
  return h('aside', { className: 'gw-rail' },
    h('div', { className: 'gw-rail-tabs' }, h('span', { className: 'gw-rail-tab active' }, 'Assistant')),
    h('div', { className: 'gw-rail-divider' }),
    h('div', { className: 'gw-rail-body gw-scroll' },
      h('div', { className: 'gw-rail-empty' },
        h('div', { className: 'gw-rail-empty-mark', innerHTML: wovenMarkSvg(28, 'ai') }),
        h('div', null, 'Open a note and geneWeave AI will help you write, edit, and diagram alongside you.'),
      ),
    ),
  );
}
