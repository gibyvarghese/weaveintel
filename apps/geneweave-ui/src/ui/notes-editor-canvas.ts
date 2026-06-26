// SPDX-License-Identifier: MIT
/**
 * geneWeave Notes — the centre CANVAS (presentational).
 *
 * Renders the editor's middle column exactly per the design handoff: a sticky top bar
 * (breadcrumb · presence · Pro/Creative theme toggle · + Insert), a formatting tool strip
 * (B/I/U · highlighter swatches · pen/shape · Ask AI), and the page itself (title · meta ·
 * the editor mount, with the inline feature panels living above it).
 *
 * This module is DUMB: it takes already-wired DOM elements (the title input, the editor
 * mount, the inline panels) and a bag of handlers, and lays them out. All state + wiring
 * lives in the container (notes-view.ts). Keeping render and logic separate is what makes
 * the editor easy to evolve — see the research notes in the PR description.
 */
import { h } from './dom.js';
import { wovenMarkSvg } from './notes-brand.js';

export interface OverflowItem { label: string; title: string; onClick: () => void; danger?: boolean; active?: boolean }
export interface EditorCanvasOpts {
  breadcrumb: { notebook: string; title: string };
  creative: boolean;
  metaText: string;
  isLive: boolean;
  /** Pre-wired elements owned by the container. */
  iconEl: HTMLElement;
  titleInput: HTMLElement;
  editorContainer: HTMLElement;
  presenceBadge: HTMLElement;
  refreshNudge: HTMLElement;
  inlinePanels: HTMLElement[];
  extractResult: string | null;
  /** Handlers. */
  onSetTheme: (t: 'pro' | 'creative') => void;
  onAskAi: () => void;
  onInsert: () => void;
  format: { bold: () => void; italic: () => void; underline: () => void; highlight: (color: string) => void };
  overflow: OverflowItem[];
}

const HIGHLIGHTERS = ['var(--hl-amber)', 'var(--hl-pink)', 'var(--hl-teal)', 'var(--hl-blue)'];

function toolBtn(label: string, title: string, onClick: () => void, extraClass = ''): HTMLElement {
  return h('button', { className: `gw-tool ${extraClass}`, title, onClick }, label);
}

export function renderEditorCanvas(opts: EditorCanvasOpts): HTMLElement {
  // — presence cluster: "you" (ink G) + the AI woven-mark avatar —
  const presence = h('div', { className: 'gw-presence' },
    opts.presenceBadge,
    h('span', { className: 'gw-avatar gw-avatar-you', title: 'You' }, 'G'),
    h('span', { className: 'gw-avatar gw-avatar-ai', title: 'geneWeave AI', innerHTML: wovenMarkSvg(13, 'ai') }),
  );

  // — Pro/Creative theme toggle —
  const themeToggle = h('div', { className: 'gw-theme-toggle' },
    h('button', { className: `gw-theme-tab${opts.creative ? '' : ' active'}`, onClick: () => opts.onSetTheme('pro') }, 'Pro'),
    h('button', { className: `gw-theme-tab${opts.creative ? ' active' : ''}`, onClick: () => opts.onSetTheme('creative') }, 'Creative'),
  );

  // — overflow (⋯) menu holding the secondary actions (share/publish/extract/fav/delete + panel toggles) —
  let overflowOpen = false;
  const overflowMenu = h('div', { className: 'gw-overflow-menu' },
    ...opts.overflow.map((it) => h('button', {
      className: `gw-overflow-item${it.danger ? ' danger' : ''}${it.active ? ' active' : ''}`,
      title: it.title,
      onClick: () => { overflowOpen = false; overflowMenu.style.display = 'none'; it.onClick(); },
    }, it.label)),
  ) as HTMLElement;
  overflowMenu.style.display = 'none';
  const overflowBtn = h('button', {
    className: 'gw-icon-btn', title: 'More actions',
    onClick: () => { overflowOpen = !overflowOpen; overflowMenu.style.display = overflowOpen ? '' : 'none'; },
  }, '⋯');

  const topbar = h('header', { className: 'gw-topbar' },
    h('div', { className: 'gw-breadcrumb' },
      h('span', null, opts.breadcrumb.notebook),
      h('span', { className: 'gw-breadcrumb-sep' }, '/'),
      h('span', { className: 'gw-breadcrumb-cur' }, opts.breadcrumb.title || 'Untitled'),
    ),
    h('div', { className: 'gw-topbar-right' },
      presence,
      themeToggle,
      h('button', { className: 'gw-btn-emerald', onClick: opts.onInsert }, h('span', { className: 'gw-plus' }, '+'), ' Insert'),
      h('div', { className: 'gw-overflow' }, overflowBtn, overflowMenu),
    ),
  );

  // — formatting tool strip —
  const toolstrip = h('div', { className: 'gw-toolstrip' },
    h('div', { className: 'gw-tool-group' },
      toolBtn('B', 'Bold', opts.format.bold, 'gw-tool-b'),
      toolBtn('I', 'Italic', opts.format.italic, 'gw-tool-i'),
      toolBtn('U', 'Underline', opts.format.underline, 'gw-tool-u'),
    ),
    h('div', { className: 'gw-tool-group gw-highlighters' },
      ...HIGHLIGHTERS.map((c, i) => h('span', {
        className: `gw-hl${i === 0 ? ' active' : ''}`, title: 'Highlight', style: `background:${c}`,
        onClick: () => opts.format.highlight(c),
      })),
    ),
    h('div', { className: 'gw-tool-group' },
      h('span', { className: 'gw-tool', title: 'Pen', innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18z"/></svg>' }),
      h('span', { className: 'gw-tool', title: 'Shape', innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>' }),
      ...(opts.creative ? [h('span', { className: 'gw-tool', title: 'Sticker' }, '✨')] : []),
    ),
    h('button', { className: 'gw-ask-ai', onClick: opts.onAskAi },
      h('span', { className: 'gw-ask-mark', innerHTML: wovenMarkSvg(14, 'ai') }), ' Ask AI'),
  );

  // — the page —
  const metaLine = h('div', { className: 'gw-page-meta' },
    h('span', { className: 'gw-meta-mono' }, opts.metaText),
    opts.isLive ? h('span', null, '·') : null,
    opts.isLive ? h('span', { className: 'gw-ai-here' }, h('span', { className: 'gw-ai-dot' }), 'geneWeave AI is here') : null,
  );

  const page = h('div', { className: 'gw-page-scroll gw-scroll' },
    h('article', { className: 'gw-page' },
      h('div', { className: 'gw-page-title' }, opts.iconEl, opts.titleInput),
      metaLine,
      opts.extractResult ? h('div', { className: 'gw-extract-result' }, opts.extractResult) : null,
      ...opts.inlinePanels,
      opts.editorContainer,
    ),
  );

  return h('main', { className: `gw-canvas${opts.creative ? ' creative' : ''}` }, topbar, opts.refreshNudge, toolstrip, page);
}
