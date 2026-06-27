// SPDX-License-Identifier: MIT
/**
 * geneWeave BUILDER — the admin "configure the assistant" surface, recreated from
 * "GeneWeave Builder.dc.html". A full-bleed THREE-pane app: an ASSISTANT-SETUP nav, a
 * collection of "Building blocks", and a bespoke record editor. It is wired to the REAL
 * `prompt-fragments` resource (`/api/admin/prompt-fragments`) — every block is a reusable
 * prompt fragment, so editing here changes production prompts. Master-detail throughout:
 * selecting a row loads it into the editor; the list never jumps pages.
 *
 * "Color encodes agency": one filled emerald action per view; the active nav item + row
 * wear a mint pill / mint fill + emerald bar; destructive actions are demoted to a warm
 * danger card. Modular: the editor pane lives in builder-editor.ts (presentational); this
 * file owns the state + data + the nav and collection panes.
 */
import { h } from './dom.js';
import { state } from './state.js';
import { api } from './api.js';
import { wovenMarkSvg, wordmarkHtml } from './notes-brand.js';
import { renderBuilderEditor, renderBuilderActionBar, validateJson, type BuilderDraft } from './builder-editor.js';

interface FragmentRow { id: string; key: string; name: string; description?: string | null; content: string; variables?: string | null; tags?: string | null; version?: string | null; enabled: number }

// ── module-local Builder state ───────────────────────────────────────────────
let _fragments: FragmentRow[] = [];
let _selectedId: string | null = null;
let _draft: BuilderDraft | null = null;
let _pristine: BuilderDraft | null = null;
let _toast = false;
let _loaded = false;
let _loading = false;
let _toastTimer: ReturnType<typeof setTimeout> | null = null;

function toDraft(f: FragmentRow): BuilderDraft {
  let tags: string[] = [];
  try { tags = f.tags ? (JSON.parse(f.tags) as string[]) : []; } catch { tags = []; }
  return {
    id: f.id, key: f.key, name: f.name, description: f.description ?? '', content: f.content,
    variables: f.variables ?? '[]', tags, version: f.version ?? '1.0', enabled: f.enabled !== 0,
  };
}
function clone(d: BuilderDraft): BuilderDraft { return JSON.parse(JSON.stringify(d)) as BuilderDraft; }
function isDirty(): boolean { return !!_draft && !!_pristine && JSON.stringify(_draft) !== JSON.stringify(_pristine); }

async function loadFragments(render: () => void): Promise<void> {
  _loading = true;
  try {
    const res = await api.get('/api/admin/prompt-fragments');
    if (res.ok) {
      _fragments = ((await res.json()) as { fragments: FragmentRow[] }).fragments ?? [];
      if (!_selectedId && _fragments[0]) selectFragment(_fragments[0].id);
    }
  } catch { /* surfaced as empty */ }
  finally { _loaded = true; _loading = false; render(); }
}
function selectFragment(id: string): void {
  const f = _fragments.find((x) => x.id === id);
  if (!f) return;
  _selectedId = id; _draft = toDraft(f); _pristine = clone(_draft); _toast = false;
}
function patch(field: keyof BuilderDraft, value: unknown, render: () => void): void {
  if (!_draft) return;
  (_draft as unknown as Record<string, unknown>)[field] = value;
  render();
}

async function save(render: () => void): Promise<void> {
  if (!_draft || validateJson(_draft.variables)) return;
  const body = { key: _draft.key, name: _draft.name, description: _draft.description, content: _draft.content, variables: _draft.variables, tags: _draft.tags, version: _draft.version, enabled: _draft.enabled };
  try {
    const res = _draft.isNew
      ? await api.post('/api/admin/prompt-fragments', body)
      : await api.put(`/api/admin/prompt-fragments/${_draft.id}`, body);
    if (!res.ok) { alert(`Could not save (HTTP ${res.status}).`); return; }
    const saved = ((await res.json()) as { fragment: FragmentRow }).fragment;
    // Refresh the list + reselect the saved record.
    await loadFragmentsQuiet();
    selectFragment(saved.id);
    _toast = true;
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { _toast = false; render(); }, 2200);
  } catch { alert('Could not save.'); }
  render();
}
async function loadFragmentsQuiet(): Promise<void> {
  try { const res = await api.get('/api/admin/prompt-fragments'); if (res.ok) _fragments = ((await res.json()) as { fragments: FragmentRow[] }).fragments ?? []; } catch { /* */ }
}
function cancel(render: () => void): void {
  if (_draft?.isNew) { _fragments = _fragments.filter((f) => f.id !== _draft!.id); _selectedId = null; if (_fragments[0]) selectFragment(_fragments[0].id); }
  else if (_pristine) { _draft = clone(_pristine); }
  render();
}
async function remove(render: () => void): Promise<void> {
  if (!_draft) return;
  if (_draft.isNew) { cancel(render); return; }
  if (!confirm('Delete this building block? This can’t be undone.')) return;
  try { await api.del(`/api/admin/prompt-fragments/${_draft.id}`); } catch { /* */ }
  await loadFragmentsQuiet();
  _selectedId = null; _draft = null; _pristine = null;
  if (_fragments[0]) selectFragment(_fragments[0].id);
  render();
}
function newRecord(render: () => void): void {
  const draft: BuilderDraft = { id: `new-${Date.now()}`, key: 'newBlock', name: 'Untitled block', description: '', content: '', variables: '[]', tags: [], version: '0.1.0', enabled: false, isNew: true };
  _fragments = [{ id: draft.id, key: draft.key, name: draft.name, content: '', enabled: 0, version: draft.version }, ..._fragments];
  _selectedId = draft.id; _draft = draft; _pristine = clone(draft);
  render();
}

// ── ASSISTANT-SETUP nav (mapped to real admin tabs) ──────────────────────────
const STUDIO_NAV: Array<{ label: string; tab?: string; active?: boolean }> = [
  { label: 'Instructions', tab: 'prompts' },
  { label: 'Version history', tab: 'prompt-versions' },
  { label: 'Building blocks', active: true },
  { label: 'Response formats', tab: 'prompt-contracts' },
  { label: 'Thinking styles', tab: 'strategies' },
  { label: 'Auto-tuning', tab: 'optimizers' },
];

function renderLeftNav(render: () => void): HTMLElement {
  const goAdmin = (tab?: string): void => { state.view = 'admin'; if (tab) state.adminTab = tab; render(); };
  const userName = (state.user as { name?: string; email?: string } | undefined)?.name ?? 'Admin';
  return h('nav', { className: 'bld-nav' },
    h('button', { className: 'bld-brand', title: 'Back to geneWeave', onClick: () => { state.view = 'chat'; render(); } },
      h('span', { innerHTML: wovenMarkSvg(26, 'duo') }), h('span', { className: 'bld-brand-word', innerHTML: wordmarkHtml() })),
    h('div', { className: 'bld-nav-body gw-scroll' },
      h('div', { className: 'bld-nav-group' },
        h('div', { className: 'bld-nav-label' }, 'ASSISTANT SETUP'),
        ...STUDIO_NAV.map((n) => h('div', { className: `bld-nav-item${n.active ? ' active' : ''}`, onClick: () => { if (!n.active) goAdmin(n.tab); } },
          h('span', { className: 'bld-nav-dot' }), h('span', null, n.label))),
      ),
      h('div', { className: 'bld-nav-group' },
        ...['Workflows', 'Request handling', 'Rules & limits', 'Connected apps'].map((l) =>
          h('div', { className: 'bld-nav-item plain', onClick: () => goAdmin() }, h('span', null, l))),
      ),
    ),
    h('div', { className: 'bld-nav-foot' },
      h('div', { className: 'bld-nav-item plain', onClick: () => { state.view = 'chat'; render(); } },
        h('span', { className: 'bld-nav-arrow', innerHTML: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>' }), h('span', null, 'Switch to Daily')),
      h('div', { className: 'bld-nav-account' }, h('span', { className: 'bld-account-avatar' }, (userName[0] ?? 'G').toUpperCase()), h('span', null, `${userName} · Admin`)),
    ),
  );
}

// ── Collection pane ──────────────────────────────────────────────────────────
function renderCollection(render: () => void): HTMLElement {
  return h('section', { className: 'bld-collection' },
    h('header', { className: 'bld-coll-head' },
      h('div', { className: 'bld-coll-titlebar' },
        h('div', { className: 'bld-coll-title-wrap' }, h('h1', { className: 'bld-coll-title' }, 'Building blocks'), h('span', { className: 'bld-coll-count' }, String(_fragments.length))),
        h('button', { className: 'bld-new-btn', onClick: () => newRecord(render) }, h('span', { className: 'bld-new-plus' }, '+'), ' New'),
      ),
      h('div', { className: 'bld-coll-search-row' },
        h('div', { className: 'bld-coll-search' },
          h('span', { className: 'bld-coll-search-ic', innerHTML: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg>' }),
          h('span', { className: 'bld-coll-search-ph' }, 'Search building blocks'),
        ),
        h('button', { className: 'bld-coll-filter', innerHTML: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 5h18M6 12h12M10 19h4"/></svg>' }),
      ),
      h('div', { className: 'bld-coll-cols' }, h('span', { className: 'bld-col-name' }, 'NAME'), h('span', { className: 'bld-col-status' }, 'STATUS')),
    ),
    h('div', { className: 'bld-coll-list gw-scroll' },
      _loading ? h('div', { className: 'bld-coll-empty' }, 'Loading…') : null,
      ...(_fragments.map((f) => {
        const on = f.enabled !== 0;
        const active = f.id === _selectedId;
        return h('div', { className: `bld-row${active ? ' active' : ''}`, onClick: () => { selectFragment(f.id); render(); } },
          h('span', { className: `bld-row-dot${on ? ' on' : ''}` }),
          h('div', { className: 'bld-row-body' }, h('div', { className: 'bld-row-name' }, f.name || 'Untitled'), h('div', { className: 'bld-row-key' }, f.key || '')),
          h('span', { className: `bld-pill${on ? ' on' : ' off'}` }, on ? 'On' : 'Off'),
        );
      })),
      (!_loading && _fragments.length === 0) ? h('div', { className: 'bld-coll-empty' }, 'No building blocks yet — press + New.') : null,
    ),
    h('footer', { className: 'bld-coll-foot' },
      h('span', { className: 'bld-coll-range' }, _fragments.length ? `1–${_fragments.length} of ${_fragments.length}` : '0 of 0'),
      h('div', { className: 'bld-coll-pager' }, h('button', { className: 'bld-pager-btn', disabled: true }, '‹'), h('button', { className: 'bld-pager-btn', disabled: true }, '›')),
    ),
  );
}

// ── Editor pane (header + the editor module + the action bar) ────────────────
function renderEditorPane(render: () => void): HTMLElement {
  if (!_draft) {
    return h('section', { className: 'bld-editor' }, h('div', { className: 'bld-editor-empty' }, 'Select a building block, or press + New.'));
  }
  const dirty = isDirty();
  const jsonInvalid = !!validateJson(_draft.variables);
  const editor = renderBuilderEditor(_draft, dirty, {
    onField: (f, v) => patch(f, v, render),
    onToggle: () => patch('enabled', !_draft!.enabled, render),
    onAddTag: (label) => patch('tags', [...(_draft!.tags), label], render),
    onRemoveTag: (i) => patch('tags', _draft!.tags.filter((_, j) => j !== i), render),
    onFormatJson: () => { try { patch('variables', JSON.stringify(JSON.parse(_draft!.variables), null, 2), render); } catch { /* invalid → leave as-is */ } },
    onSave: () => void save(render),
    onCancel: () => cancel(render),
    onDelete: () => void remove(render),
  });
  return h('section', { className: 'bld-editor' },
    h('header', { className: 'bld-editor-head' },
      h('div', { className: 'bld-editor-titles' },
        h('div', { className: 'bld-editor-eyebrow' }, 'ASSISTANT SETUP / BUILDING BLOCKS'),
        h('h2', { className: 'bld-editor-name' }, _draft.name || 'Untitled block'),
      ),
      h('button', { className: 'bld-editor-more' }, '⋯'),
    ),
    editor,
    renderBuilderActionBar(dirty, jsonInvalid, { onSave: () => void save(render), onCancel: () => cancel(render) }),
  );
}

/** The Builder app (full-bleed three-pane). */
export function renderBuilderView(render: () => void): HTMLElement {
  if (!_loaded && !_loading) void loadFragments(render);
  return h('div', { className: 'bld-app' },
    renderLeftNav(render),
    renderCollection(render),
    renderEditorPane(render),
    _toast ? h('div', { className: 'bld-toast' }, h('span', { className: 'bld-toast-check', innerHTML: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2FD39B" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' }), 'Saved') : null,
  );
}
