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
import { wireNoteConnections, type NoteConnectionsPanel } from './notes-graph.js';
import { renderDatabasesView } from './notes-database-view.js';
import { renderCapturePanel } from './notes-capture.js';
import { wireNoteHistory, wireNoteComments, wireNoteSynced, renderWorkspaceAsk, type SimplePanel } from './notes-workspace-ui.js';
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
/** The knowledge-graph connections panel for the currently-open note (Phase 5). */
let _activeConn: NoteConnectionsPanel | null = null;
/** Phase 8 panels: version history, comments, synced blocks. */
let _activeHistory: SimplePanel | null = null;
let _activeComments: SimplePanel | null = null;
let _activeSynced: SimplePanel | null = null;
function teardownCoedit(): void {
  if (_activeCoedit) { _activeCoedit.close(); _activeCoedit = null; }
  if (_activeAi) { _activeAi.close(); _activeAi = null; }
  if (_activeCard) { _activeCard.destroy(); _activeCard = null; }
  if (_activeConn) { _activeConn.close(); _activeConn = null; }
  if (_activeHistory) { _activeHistory.close(); _activeHistory = null; }
  if (_activeComments) { _activeComments.close(); _activeComments = null; }
  if (_activeSynced) { _activeSynced.close(); _activeSynced = null; }
}

// ── Data loaders ──────────────────────────────────────────────────────────────

export async function loadNotesList(opts?: { search?: string }): Promise<void> {
  state.notesLoading = true;
  try {
    const params = new URLSearchParams({ parent: 'null' });
    if (opts?.search) params.set('search', opts.search);
    if (state.notesSearch) params.set('search', state.notesSearch as string);
    const res = await api.get(`/api/me/notes?${params}`);
    if (!res.ok) return;
    const { notes } = await res.json() as { notes: NoteListItem[] };
    state.notesItems = notes;
  } catch (e) {
    console.warn('[notes-view] loadNotesList error', e);
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

export async function loadNote(id: string): Promise<void> {
  try {
    const res = await api.get(`/api/me/notes/${id}`);
    if (!res.ok) return;
    const note = await res.json() as NoteDoc;
    state.currentNote = note;
    state.currentNoteId = note.id;
    // weaveNotes Phase 1: adopt the note's persisted page theme (spec §10.6).
    const theme = (note as { page_theme?: string }).page_theme;
    state.notesTheme = theme === 'creative' ? 'creative' : 'pro';
  } catch (e) {
    console.warn('[notes-view] loadNote error', e);
  }
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

async function createNote(templateId?: string): Promise<NoteListItem | null> {
  try {
    const body: Record<string, unknown> = { title: 'Untitled' };
    if (templateId) body['template_id'] = templateId;
    const res = await api.post('/api/me/notes', body);
    if (!res.ok) return null;
    return res.json() as Promise<NoteListItem>;
  } catch {
    return null;
  }
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

function renderTemplatesGallery(render: () => void): HTMLElement {
  const templates: NoteListItem[] = state.noteTemplates ?? [];

  return h('div', { className: 'notes-templates' },
    h('div', { className: 'notes-templates-header' },
      h('button', { className: 'notes-back-btn', onClick: () => { state.notesView = 'list'; render(); } }, '← Notes'),
      h('div', { className: 'notes-templates-title' }, 'Templates'),
    ),
    h('div', { className: 'notes-template-grid' },
      ...templates.map((tmpl) =>
        h('div', {
          className: 'notes-template-card',
          onClick: async () => {
            const note = await createNote(tmpl.id);
            if (note) {
              state.notesItems = [note as NoteListItem, ...(state.notesItems as NoteListItem[])];
              await loadNote(note.id);
              state.notesView = 'editor';
              render();
            }
          },
        },
          h('div', { className: 'notes-template-icon' }, tmpl.icon ?? '📄'),
          h('div', { className: 'notes-template-title' }, tmpl.title),
        )
      ),
      templates.length === 0
        ? h('div', { className: 'notes-empty' }, 'No templates available')
        : null,
    )
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

function buildInsertMenu(render: () => void): OverflowItem[] {
  const openNote = async (id: string): Promise<void> => { await loadNote(id); state.notesView = 'editor'; render(); };
  return [
    { label: '📝 New note', title: 'Create a blank note', onClick: async () => { const n = await createNote(); if (n) { state.notesItems = [n as NoteListItem, ...(state.notesItems as NoteListItem[])]; await openNote(n.id); } } },
    { label: '⊞ New from template', title: 'Start from a template', onClick: async () => { await loadNoteTemplates(); state.notesView = 'templates'; render(); } },
    { label: '🌐 Capture a web page', title: 'Clip a public page into a note', onClick: async () => {
        const url = prompt('Paste a public web page URL to clip into a note:'); if (!url) return;
        const res = await api.post('/api/me/notes/capture/web', { url }).catch(() => null);
        const data = res && res.ok ? await res.json().catch(() => ({})) as { noteId?: string } : null;
        if (data?.noteId) { await loadNotesList(); await openNote(data.noteId); } else { alert('Could not clip that page.'); }
      } },
    { label: '✦ Ask your workspace', title: 'Search your notes + chats with citations', onClick: () => {
        openCenterModal('Ask your workspace', renderWorkspaceAsk((id) => { void openNote(id); document.querySelector('.gw-modal-overlay')?.remove(); }));
      } },
    { label: '🗃 Databases', title: 'Tables with AI auto-fill', onClick: () => { state.currentDatabaseId = null; state.notesView = 'databases'; render(); } },
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
  let mountTs = 0;
  const presenceBadge = h('span', { className: 'notes-presence-badge', title: 'People editing this note', style: 'display:none' }) as HTMLElement;
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
    const typingNow = editorContainer.contains(document.activeElement) && Date.now() - lastLocalEditTs < 2500;
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
    { label: '⊡ Extract to-dos', title: 'Extract to-dos as tasks', onClick: async () => {
        const result = await extractNote(note.id);
        if (result) { const count = result.extractedTasks.length; extractResult = count > 0 ? `${count} task${count === 1 ? '' : 's'} created` : 'No new to-dos found'; render(); }
      } },
    { label: '🗑 Delete note', title: 'Delete note', danger: true, onClick: async () => {
        if (!confirm('Delete this note? This cannot be undone.')) return;
        destroyActiveEditor();
        await deleteNote(note.id);
        state.currentNoteId = null; state.currentNote = null; state.notesView = 'list';
        await loadNotesList(); render();
      } },
  ];

  // — formatting commands drive the live Tiptap instance (no-op until it mounts) —
  const fmt = (cmd: string, arg?: unknown): void => {
    try {
      const ed = _activeEditor as unknown as { chain?: () => { focus: () => Record<string, (a?: unknown) => { run: () => void }> } } | null;
      ed?.chain?.().focus()?.[cmd]?.(arg)?.run();
    } catch { /* editor not ready / command unavailable */ }
  };

  // — the Assistant body for the right rail: a mint AI greeting bubble (design), then the
  //   AI co-author actions (styled as suggestion buttons) + the pending-suggestion panel —
  const assistantBody = h('div', { className: 'gw-assistant-body' },
    h('div', { className: 'gw-ai-msg' },
      h('span', { className: 'gw-ai-msg-avatar', innerHTML: wovenMarkSvg(14, 'ai') }),
      h('div', { className: 'gw-ai-msg-bubble' }, 'I can help with this note — continue your writing, rewrite a passage, summarize the page, or turn it into something new.'),
    ),
    aiToolbar,
    aiPanel,
  );

  // — compute the outline from the note's headings (best-effort from doc_json) —
  const outline = computeOutline(note.doc_json);

  // — CENTRE canvas (presentational module) —
  const center = renderEditorCanvas({
    breadcrumb: { notebook: 'Notes', title: note.title },
    creative,
    metaText: 'Edited just now',
    isLive: true,
    iconEl, titleInput, editorContainer, presenceBadge,
    inlinePanels: [historyPanel, commentsPanel, syncedPanel],
    extractResult,
    onSetTheme: (t) => {
      state.notesTheme = t;
      if (state.currentNote) (state.currentNote as { page_theme?: string }).page_theme = t;
      void saveNoteTheme(note.id, t);
      render();
    },
    onAskAi: () => { _railTab = 'assistant'; render(); },
    format: { bold: () => fmt('toggleBold'), italic: () => fmt('toggleItalic'), underline: () => fmt('toggleUnderline'), highlight: (color) => fmt('toggleHighlight', { color }), sticker: () => fmt('setSticker', { emoji: '✨' }) },
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
    _activeCoedit = wireNoteCoedit({ noteId: note.id, onRemoteChange, onPresence: updatePresence });
    // Phase 3: wire the AI co-author toolbar + suggestion review. Accepting a
    // suggestion (or inserting/refreshing an AI block) reloads the note so the
    // editor reflects the applied change.
    _activeAi = wireNoteAi({ noteId: note.id, toolbarEl: aiToolbar, panelEl: aiPanel, onApplied: () => { void loadNote(note.id).then(render); } });
    // Phase 2: the floating AI selection card — select text → card → ask/colour → suggestion.
    _activeCard = wireSelectionCard({ container: editorContainer, noteId: note.id, onSuggestion: () => { _railTab = 'assistant'; void _activeAi?.refresh(); } });
    // Phase 5: wire the knowledge-graph connections panel (hidden until the button opens it).
    _activeConn = wireNoteConnections({ noteId: note.id, panelEl: connPanel, onOpenNote: (id) => { void loadNote(id).then(render); } });
    // Phase 8: wire the version-history, comments, and synced-blocks panels (hidden until opened).
    _activeHistory = wireNoteHistory({ noteId: note.id, panelEl: historyPanel, onRestored: () => { void loadNote(note.id).then(render); } });
    _activeComments = wireNoteComments({ noteId: note.id, panelEl: commentsPanel });
    _activeSynced = wireNoteSynced({ noteId: note.id, panelEl: syncedPanel });

    mountNotesEditor({
      container: editorContainer,
      initialDocJson: note.doc_json,
      placeholder: 'Start writing… type / for commands, @ to mention',
      onSave: async (docJson) => {
        lastLocalEditTs = Date.now();
        let parsed: unknown; try { parsed = JSON.parse(docJson); } catch { parsed = undefined; }
        // Prefer the convergent relay path; fall back to the legacy save if it's unavailable.
        const merged = parsed !== undefined && _activeCoedit ? await _activeCoedit.save(parsed) : false;
        if (!merged) await saveNote(note.id, docJson);
      },
    }).then((inst) => {
      _activeEditor = inst;
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

  const centre = notesView === 'databases'
    ? h('main', { className: 'gw-canvas' }, renderDatabasesView(render))
    : notesView === 'templates'
      ? h('main', { className: 'gw-canvas' }, renderTemplatesGallery(render))
      : composed
        ? composed.center
        : h('main', { className: 'gw-canvas' },
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
    onHome: () => { state.view = 'home'; render(); },
  });

  return h('div', { className: 'gw-notes notes-full-view' },
    h('div', { className: 'gw-shell' }, leftRail, centre, rightRail),
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
