// SPDX-License-Identifier: MIT
/**
 * geneWeave Notes — the left NOTEBOOKS rail (presentational), per the design handoff.
 *
 * The standalone Notes app's primary navigation: the brand lockup (click → back to the rest
 * of geneWeave), a search field with a ⌘K hint, a "NOTEBOOKS" tree of the user's notes (each a
 * doc-icon row; the open note is a mint pill with emerald text), and a "+ New note" footer.
 *
 * Dumb module: it takes the note list + handlers and renders. Secondary creators (templates,
 * capture, databases, ask-workspace) are NOT crammed in here — they live in the centre top-bar
 * "+ Insert" menu, keeping the rail as calm as the design.
 */
import { h } from './dom.js';
import type { NoteListItem } from './state.js';
import { wovenMarkSvg, wordmarkHtml } from './notes-brand.js';

export interface LeftRailOpts {
  notes: NoteListItem[];
  loading: boolean;
  currentNoteId: string | null;
  search: string;
  onSearch: (q: string) => void;
  onOpenNote: (id: string) => void;
  onToggleFav: (note: NoteListItem) => void;
  onNewNote: () => void;
  onTemplates: () => void;
  onArchived: () => void;
  onHome: () => void;
}

const DOC_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4h12l4 4v12H4z"/><path d="M8 9h6M8 13h8M8 17h5"/></svg>';

function noteRow(note: NoteListItem, active: boolean, opts: LeftRailOpts): HTMLElement {
  const isFav = note.favorite === 1;
  return h('div', {
    className: `gw-tree-row${active ? ' active' : ''}`,
    onClick: () => opts.onOpenNote(note.id),
  },
    note.icon && note.icon !== '📄'
      ? h('span', { className: 'gw-tree-emoji' }, note.icon)
      : h('span', { className: 'gw-tree-icon', innerHTML: DOC_ICON }),
    h('span', { className: 'gw-tree-label' }, note.title || 'Untitled'),
    h('button', {
      className: `gw-tree-fav${isFav ? ' on' : ''}`,
      title: isFav ? 'Unfavourite' : 'Favourite',
      onClick: (e: Event) => { e.stopPropagation(); opts.onToggleFav(note); },
    }, isFav ? '★' : '☆'),
  );
}

export function renderLeftRail(opts: LeftRailOpts): HTMLElement {
  const favs = opts.notes.filter((n) => n.favorite);
  const others = opts.notes.filter((n) => !n.favorite);

  const searchInput = h('input', {
    className: 'gw-search-input', type: 'text', placeholder: 'Search notes',
    value: opts.search,
    onInput: (e: Event) => opts.onSearch((e.target as HTMLInputElement).value),
  }) as HTMLInputElement;

  return h('div', { className: 'gw-leftrail' },
    // brand (click → back to the rest of geneWeave)
    h('button', { className: 'gw-brand', title: 'Back to geneWeave', onClick: opts.onHome },
      h('span', { className: 'gw-brand-mark', innerHTML: wovenMarkSvg(24, 'duo') }),
      h('span', { className: 'gw-brand-word', innerHTML: wordmarkHtml() }),
    ),
    // search
    h('div', { className: 'gw-search' },
      h('span', { className: 'gw-search-ic', innerHTML: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg>' }),
      searchInput,
      h('span', { className: 'gw-kbd' }, '⌘K'),
    ),
    // tree
    h('div', { className: 'gw-tree gw-scroll' },
      opts.loading ? h('div', { className: 'gw-tree-loading' }, 'Loading…') : null,
      favs.length > 0 ? h('div', { className: 'gw-tree-label-row' }, 'FAVOURITES') : null,
      ...favs.map((n) => noteRow(n, opts.currentNoteId === n.id, opts)),
      h('div', { className: 'gw-tree-label-row' }, 'NOTEBOOKS'),
      ...others.map((n) => noteRow(n, opts.currentNoteId === n.id, opts)),
      (!opts.loading && opts.notes.length === 0)
        ? h('div', { className: 'gw-tree-empty' }, 'No notes yet — start one below.')
        : null,
    ),
    // footer: + New note (with templates + archived affordances)
    h('button', { className: 'gw-newnote', onClick: opts.onNewNote },
      h('span', { className: 'gw-newnote-plus' }, '+'),
      h('span', null, 'New note'),
      h('span', { className: 'gw-newnote-tmpl', title: 'Start from a template', onClick: (e: Event) => { e.stopPropagation(); opts.onTemplates(); } }, 'templates'),
    ),
    h('button', { className: 'gw-newnote-archived', title: 'View + restore archived notes', onClick: opts.onArchived },
      h('span', { className: 'gw-newnote-archived-ic', innerHTML: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/></svg>' }),
      h('span', null, 'Archived'),
    ),
  );
}
