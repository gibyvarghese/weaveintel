// SPDX-License-Identifier: MIT
/**
 * weaveNotes Phase 3 — front-end for the AI co-author.
 *
 * --- For someone new to this ---
 * This adds an "AI" toolbar to a note. You can ask the AI to CONTINUE writing,
 * REWRITE the note, SUMMARIZE it, or ANSWER a question — and, crucially, the AI's
 * output does NOT change your note straight away. It appears as a SUGGESTION you can
 * Accept (apply it) or Reject (throw it away). This "track-changes" approach is the
 * safe, mid-2026 way to let an AI edit a document: it never silently rewrites your
 * words. You can also drop in an "AI block" — a paragraph generated from a prompt
 * that remembers the prompt, so you can Refresh it later to regenerate.
 */
import { h } from './dom.js';
import { api } from './api.js';

export interface NoteAiPanel {
  /** Re-fetch + re-render the pending suggestions list. */
  refresh(): Promise<void>;
  /** Tear down (no live resources today, but symmetric with the co-edit session). */
  close(): void;
}

interface Suggestion { id: string; action: string; status: string; preview: string; authorKind: string }

/**
 * Build the AI toolbar + suggestions panel for a note and wire all the actions.
 * `onApplied` is called after a suggestion is accepted / an AI block is inserted or
 * refreshed, so the host can reload the note content into the editor.
 */
export function wireNoteAi(opts: { noteId: string; toolbarEl: HTMLElement; panelEl: HTMLElement; onApplied: () => void }): NoteAiPanel {
  const { noteId, toolbarEl, panelEl, onApplied } = opts;

  async function runAction(action: 'continue' | 'rewrite' | 'summarize' | 'ask', instruction?: string): Promise<void> {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (instruction) body['instruction'] = instruction;
      const res = await api.post(`/api/me/notes/${noteId}/ai/${action}`, body);
      if (!res.ok) { const e = await res.json().catch(() => ({})) as { error?: string }; alert(`AI ${action} failed: ${e.error ?? res.status}`); return; }
      await refresh(); // the new suggestion shows in the panel for review
    } finally { setBusy(false); }
  }

  async function insertBlock(): Promise<void> {
    const prompt = window.prompt('Describe the AI block to insert (it remembers this prompt so you can refresh it later):');
    if (!prompt) return;
    setBusy(true);
    try {
      const res = await api.post(`/api/me/notes/${noteId}/ai/insert-block`, { prompt, citation: 'note:self' });
      if (res.ok) onApplied(); else alert('Could not insert AI block.');
    } finally { setBusy(false); }
  }

  async function resolve(id: string, decision: 'accept' | 'reject'): Promise<void> {
    setBusy(true);
    try {
      const res = await api.post(`/api/me/notes/${noteId}/suggestions/${id}/${decision}`, {});
      if (res.ok) { if (decision === 'accept') onApplied(); await refresh(); }
      else alert(`Could not ${decision} the suggestion.`);
    } finally { setBusy(false); }
  }

  function setBusy(b: boolean): void {
    toolbarEl.querySelectorAll('button').forEach((btn) => { (btn as HTMLButtonElement).disabled = b; });
    statusEl.textContent = b ? 'AI is thinking…' : '';
  }

  const statusEl = h('span', { className: 'notes-ai-status' }) as HTMLElement;

  // The AI toolbar.
  toolbarEl.innerHTML = '';
  toolbarEl.appendChild(
    h('div', { className: 'notes-ai-toolbar' },
      h('span', { className: 'notes-ai-label' }, '✨ AI'),
      h('button', { className: 'notes-ai-btn notes-ai-continue', title: 'Continue writing', onClick: () => void runAction('continue') }, 'Continue'),
      h('button', { className: 'notes-ai-btn notes-ai-rewrite', title: 'Rewrite the note', onClick: () => void runAction('rewrite') }, 'Rewrite'),
      h('button', { className: 'notes-ai-btn notes-ai-summarize', title: 'Summarize the note', onClick: () => void runAction('summarize') }, 'Summarize'),
      h('button', { className: 'notes-ai-btn notes-ai-ask', title: 'Ask the AI a question about this note', onClick: () => { const q = window.prompt('Ask the AI about this note:'); if (q) void runAction('ask', q); } }, 'Ask AI'),
      h('button', { className: 'notes-ai-btn notes-ai-insert', title: 'Insert a refreshable AI block', onClick: () => void insertBlock() }, '＋ AI block'),
      statusEl,
    ),
  );

  function renderSuggestions(list: Suggestion[]): void {
    panelEl.innerHTML = '';
    if (list.length === 0) { panelEl.style.display = 'none'; return; }
    panelEl.style.display = '';
    panelEl.appendChild(h('div', { className: 'notes-ai-suggestions-title' }, `${list.length} AI suggestion${list.length === 1 ? '' : 's'} to review`));
    for (const s of list) {
      panelEl.appendChild(
        h('div', { className: 'notes-ai-suggestion' },
          h('div', { className: 'notes-ai-suggestion-meta' }, `${s.authorKind === 'agent' ? '🤖 agent' : '✨ you'} · ${s.action}`),
          h('pre', { className: 'notes-ai-suggestion-preview' }, s.preview.slice(0, 600)),
          h('div', { className: 'notes-ai-suggestion-actions' },
            h('button', { className: 'notes-ai-accept', onClick: () => void resolve(s.id, 'accept') }, '✓ Accept'),
            h('button', { className: 'notes-ai-reject', onClick: () => void resolve(s.id, 'reject') }, '✕ Reject'),
          ),
        ),
      );
    }
  }

  async function refresh(): Promise<void> {
    try {
      const res = await api.get(`/api/me/notes/${noteId}/suggestions?status=pending`);
      if (!res.ok) { renderSuggestions([]); return; }
      const data = await res.json() as { suggestions: Suggestion[] };
      renderSuggestions(data.suggestions ?? []);
    } catch { renderSuggestions([]); }
  }

  void refresh();
  return { refresh, close() { /* nothing live to release */ } };
}
