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
  /** Phase 3: live participant avatars (updated imperatively as people/AI join + leave). */
  presenceAvatarsEl?: HTMLElement;
  inlinePanels: HTMLElement[];
  /** Panels rendered in the note body AFTER the editor content (e.g. the inline AI-edit diff cards). */
  afterEditorPanels?: HTMLElement[];
  extractResult: string | null;
  /** Handlers. */
  onSetTheme: (t: 'pro' | 'creative') => void;
  onAskAi: () => void;
  format: {
    bold: () => void; italic: () => void; underline: () => void; highlight: (color: string) => void; sticker?: () => void;
    run?: (cmd: string, arg?: unknown) => void; textColor?: (c: string) => void; link?: () => void;
  };
  /** Page column layout (1–3) + setter — the design's "one / two / three columns" board control. */
  columns?: number;
  onSetColumns?: (n: number) => void;
  insert: OverflowItem[];
  overflow: OverflowItem[];
}

/** A small dropdown of items anchored under a trigger button (Insert / overflow ⋯). */
function dropdown(trigger: HTMLElement, items: OverflowItem[], align: 'left' | 'right'): HTMLElement {
  let open = false;
  const menu = h('div', { className: `gw-menu gw-menu-${align}` },
    ...items.map((it) => h('button', {
      className: `gw-menu-item${it.danger ? ' danger' : ''}${it.active ? ' active' : ''}`, title: it.title,
      onClick: () => { open = false; menu.style.display = 'none'; it.onClick(); },
    }, it.label)),
  ) as HTMLElement;
  menu.style.display = 'none';
  trigger.addEventListener('click', () => { open = !open; menu.style.display = open ? '' : 'none'; });
  return h('div', { className: 'gw-menu-anchor' }, trigger, menu);
}

// Display uses the theme token (so dark/light stays consistent); the command gets the
// real hex (the Highlight mark refuses non-literal colours like a CSS var, for safety).
const HIGHLIGHTERS = [
  { css: 'var(--hl-amber)', hex: '#FAC775' },
  { css: 'var(--hl-pink)', hex: '#F4C0D1' },
  { css: 'var(--hl-teal)', hex: '#9FE1CB' },
  { css: 'var(--hl-blue)', hex: '#B5D4F4' },
];

function toolBtn(label: string, title: string, onClick: () => void, extraClass = ''): HTMLElement {
  return h('button', { className: `gw-tool ${extraClass}`, title, onClick }, label);
}

/** An icon tool button (SVG innerHTML). */
function iconTool(svg: string, title: string, onClick: () => void): HTMLElement {
  return h('button', { className: 'gw-tool', title, onClick, innerHTML: svg });
}

// Text colours offered in the toolbar (design palette; the AI mint/emerald is never a user text colour).
const TEXT_COLORS = ['#14201B', '#0B7A57', '#C2562B', '#3E6E8F', '#9aa7a1'];

// Column-count glyphs for the 1 / 2 / 3 board layout control.
const COL_GLYPH: Record<1 | 2 | 3, string> = {
  1: '<svg width="15" height="14" viewBox="0 0 15 14" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="2" width="11" height="10" rx="1.5"/></svg>',
  2: '<svg width="15" height="14" viewBox="0 0 15 14" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="2" width="4.6" height="10" rx="1.2"/><rect x="8.4" y="2" width="4.6" height="10" rx="1.2"/></svg>',
  3: '<svg width="15" height="14" viewBox="0 0 15 14" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1.5" y="2" width="3.2" height="10" rx="1"/><rect x="5.9" y="2" width="3.2" height="10" rx="1"/><rect x="10.3" y="2" width="3.2" height="10" rx="1"/></svg>',
};

// The block-type menu (paragraph / headings / lists / quote / code / divider), wired to editor commands.
const BLOCK_TYPES: Array<{ label: string; cmd: string; arg?: unknown }> = [
  { label: 'Text', cmd: 'setParagraph' },
  { label: 'Heading 1', cmd: 'setHeading', arg: { level: 1 } },
  { label: 'Heading 2', cmd: 'setHeading', arg: { level: 2 } },
  { label: 'Heading 3', cmd: 'setHeading', arg: { level: 3 } },
  { label: 'Bulleted list', cmd: 'toggleBulletList' },
  { label: 'Numbered list', cmd: 'toggleOrderedList' },
  { label: 'To-do list', cmd: 'toggleTaskList' },
  { label: 'Quote', cmd: 'toggleBlockquote' },
  { label: 'Code block', cmd: 'toggleCodeBlock' },
  { label: 'Divider', cmd: 'setHorizontalRule' },
];

export function renderEditorCanvas(opts: EditorCanvasOpts): HTMLElement {
  // — presence cluster: "you" (ink G) + the AI woven-mark avatar —
  const presence = h('div', { className: 'gw-presence' },
    opts.presenceBadge,
    // Phase 3: live participant avatars (populated by the live-cursors wiring). Falls back to the
    // static "you + AI" cluster until participants arrive, so the chrome never looks empty.
    opts.presenceAvatarsEl ?? h('span', { className: 'gw-avatar gw-avatar-you', title: 'You' }, 'G'),
    opts.presenceAvatarsEl ? null : h('span', { className: 'gw-avatar gw-avatar-ai', title: 'geneWeave AI', innerHTML: wovenMarkSvg(13, 'ai') }),
  );

  // — Pro/Creative theme toggle —
  const themeToggle = h('div', { className: 'gw-theme-toggle' },
    h('button', { className: `gw-theme-tab${opts.creative ? '' : ' active'}`, onClick: () => opts.onSetTheme('pro') }, 'Pro'),
    h('button', { className: `gw-theme-tab${opts.creative ? ' active' : ''}`, onClick: () => opts.onSetTheme('creative') }, 'Creative'),
  );

  // — "+ Insert" dropdown (new note / template / capture / ask / databases) —
  const insertBtn = h('button', { className: 'gw-btn-emerald' }, h('span', { className: 'gw-plus' }, '+'), ' Insert');
  const insertMenu = dropdown(insertBtn, opts.insert, 'right');
  // — overflow (⋯) menu: secondary actions (share/publish/extract/fav/delete + panel toggles) —
  const overflowBtn = h('button', { className: 'gw-icon-btn', title: 'More actions' }, '⋯');
  const overflowMenu = dropdown(overflowBtn, opts.overflow, 'right');

  // — mobile-only rail toggle: opens the notebooks rail as a slide-over drawer (hidden ≥900px via CSS).
  // Recreates the design's show/hide-sidebar affordance without a persistent 3-column grid on small screens.
  const railToggle = h('button', {
    className: 'gw-rail-toggle', type: 'button', 'aria-label': 'Show notebooks',
    innerHTML: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>',
    onClick: (e: Event) => {
      const shell = (e.currentTarget as HTMLElement).closest('.gw-shell');
      if (shell) shell.classList.toggle('rail-open');
    },
  });

  const topbar = h('header', { className: 'gw-topbar' },
    h('div', { className: 'gw-topbar-left' },
      railToggle,
      h('div', { className: 'gw-breadcrumb' },
        h('span', null, opts.breadcrumb.notebook),
        h('span', { className: 'gw-breadcrumb-sep' }, '/'),
        h('span', { className: 'gw-breadcrumb-cur' }, opts.breadcrumb.title || 'Untitled'),
      ),
    ),
    h('div', { className: 'gw-topbar-right' },
      presence,
      themeToggle,
      insertMenu,
      overflowMenu,
    ),
  );

  // — formatting tool strip —
  const run = (cmd: string, arg?: unknown) => opts.format.run?.(cmd, arg);

  // Block-type dropdown (Text / headings / lists / quote / code / divider).
  const blockBtn = h('button', { className: 'gw-tool gw-block-btn', title: 'Text style' },
    h('span', null, 'Text'),
    h('span', { className: 'gw-block-caret', innerHTML: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9aa7a1" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>' }));
  const blockMenu = h('div', { className: 'gw-menu gw-menu-left gw-block-menu' },
    ...BLOCK_TYPES.map((b) => h('button', { className: 'gw-menu-item', onClick: () => { blockMenu.style.display = 'none'; run(b.cmd, b.arg); } }, b.label))) as HTMLElement;
  blockMenu.style.display = 'none';
  blockBtn.addEventListener('click', () => { blockMenu.style.display = blockMenu.style.display === 'none' ? '' : 'none'; });
  const blockGroup = h('div', { className: 'gw-menu-anchor gw-tool-group' }, blockBtn, blockMenu);

  // Text-colour dropdown.
  const colorBtn = h('button', { className: 'gw-tool', title: 'Text colour', innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><path d="m6 16 6-12 6 12"/><path d="M8.5 12h7"/></svg>' });
  const colorMenu = h('div', { className: 'gw-menu gw-menu-left gw-color-menu' },
    ...TEXT_COLORS.map((c) => h('button', { className: 'gw-color-swatch', title: c, style: `background:${c}`, onClick: () => { colorMenu.style.display = 'none'; opts.format.textColor?.(c); } }))) as HTMLElement;
  colorMenu.style.display = 'none';
  colorBtn.addEventListener('click', () => { colorMenu.style.display = colorMenu.style.display === 'none' ? '' : 'none'; });
  const colorGroup = h('div', { className: 'gw-menu-anchor' }, colorBtn, colorMenu);

  const toolstrip = h('div', { className: 'gw-toolstrip' },
    // undo / redo
    h('div', { className: 'gw-tool-group' },
      iconTool('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10H9"/></svg>', 'Undo', () => run('undo')),
      iconTool('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h6"/></svg>', 'Redo', () => run('redo')),
    ),
    // block type
    blockGroup,
    // inline marks
    h('div', { className: 'gw-tool-group' },
      toolBtn('B', 'Bold', opts.format.bold, 'gw-tool-b'),
      toolBtn('I', 'Italic', opts.format.italic, 'gw-tool-i'),
      toolBtn('U', 'Underline', opts.format.underline, 'gw-tool-u'),
      toolBtn('S', 'Strikethrough', () => run('toggleStrike'), 'gw-tool-s'),
      iconTool('<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>', 'Link', () => opts.format.link?.()),
      colorGroup,
    ),
    // highlighters
    h('div', { className: 'gw-tool-group gw-highlighters' },
      ...HIGHLIGHTERS.map((c, i) => h('span', {
        className: `gw-hl${i === 0 ? ' active' : ''}`, title: 'Highlight', style: `background:${c.css}`,
        onClick: () => opts.format.highlight(c.hex),
      })),
    ),
    // lists
    h('div', { className: 'gw-tool-group' },
      iconTool('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="3.5" cy="18" r="1.3" fill="currentColor" stroke="none"/></svg>', 'Bulleted list', () => run('toggleBulletList')),
      iconTool('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="7" height="7" rx="1.5"/><path d="m4.5 7.5 1.5 1.5 2.5-3"/><path d="M14 6h7M14 12h7M14 18h7M3 16h7"/></svg>', 'To-do list', () => run('toggleTaskList')),
    ),
    // ink tools
    h('div', { className: 'gw-tool-group' },
      h('span', { className: 'gw-tool', title: 'Pen', innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18z"/></svg>' }),
      ...(opts.creative ? [h('span', { className: 'gw-tool gw-tool-sticker', title: 'Sticker', onClick: () => opts.format.sticker?.() }, '✨')] : []),
    ),
    // columns: one / two / three (the design's board layout control) — pushed to the right.
    h('div', { className: 'gw-cols-seg' },
      ...[1, 2, 3].map((n) => h('button', {
        className: `gw-cols-btn${(opts.columns ?? 1) === n ? ' active' : ''}`,
        title: `${n === 1 ? 'One column' : n === 2 ? 'Two columns' : 'Three columns'}`,
        onClick: () => opts.onSetColumns?.(n),
        innerHTML: COL_GLYPH[n as 1 | 2 | 3],
      }))),
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
      ...(opts.afterEditorPanels ?? []),
    ),
  );

  return h('main', { className: `gw-canvas${opts.creative ? ' creative' : ''}`, 'data-cols': String(opts.columns ?? 1) }, topbar, toolstrip, page);
}
