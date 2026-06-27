// notes-creative-extensions.ts — weaveNotes Phase 1 custom Tiptap marks + nodes.
//
// Hand-rolled (no extra @tiptap/* installs) so the editor gains text colour, a
// multi-colour highlighter, callouts, toggles, image embeds, stickers and washi
// dividers. The node/mark NAMES here MATCH the @weaveintel/coedit round-trip
// (pmToBlocks / blocksToProseMirror) exactly, so creative content survives the CRDT
// co-edit relay — and the colour the AI/user picks is preserved through a merge.
//
// `author` attributes carry the agency-colour contract (Phase 0): a callout/sticker the
// AI created renders mint; a human's stays neutral. The CSS lives in the canvas styles.
import { Mark, Node, mergeAttributes } from '@tiptap/core';

// Tiptap's RawCommands is augmented per-extension; we add commands without global
// module augmentation, so cast the returned command bag. Localized + intentional.
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Only allow an inert CSS colour (hex / rgb[a] / hsl[a] / short named). Mirrors @weaveintel/notes sanitizeColor. */
function safeColor(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s.length === 0 || s.length > 32) return null;
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^rgba?\(\s*[\d.\s,%]+\)$/.test(s)) return s;
  if (/^hsla?\(\s*[\d.\s,%]+\)$/.test(s)) return s;
  if (/^[a-zA-Z]{3,20}$/.test(s)) return s.toLowerCase();
  return null;
}

/** Only allow a safe image src scheme (http/https/data:image). */
function safeSrc(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (/^https?:\/\//i.test(s) || /^data:image\//i.test(s)) return s;
  return null;
}

// ─── Highlight mark (multi-colour highlighter) ──────────────────────────────────────
export const Highlight = Mark.create({
  name: 'highlight',
  addOptions() { return { HTMLAttributes: {} }; },
  addAttributes() {
    return {
      color: {
        default: null as string | null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-color') || el.style.backgroundColor || null,
        renderHTML: (attrs: { color?: string | null }) => {
          const c = safeColor(attrs.color);
          return c ? { 'data-color': c, style: `background-color:${c};border-radius:.2em;padding:0 .08em` } : {};
        },
      },
    };
  },
  parseHTML() { return [{ tag: 'mark' }]; },
  renderHTML({ HTMLAttributes }) { return ['mark', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0]; },
  addCommands() {
    return {
      setHighlight: (attrs: { color?: string }) => ({ commands }: any) => commands.setMark('highlight', attrs),
      toggleHighlight: (attrs: { color?: string }) => ({ commands }: any) => commands.toggleMark('highlight', attrs),
      unsetHighlight: () => ({ commands }: any) => commands.unsetMark('highlight'),
    } as any;
  },
});

// ─── Text colour mark ───────────────────────────────────────────────────────────────
export const TextColor = Mark.create({
  name: 'textColor',
  addAttributes() {
    return {
      color: {
        default: null as string | null,
        parseHTML: (el: HTMLElement) => el.style.color || null,
        renderHTML: (attrs: { color?: string | null }) => {
          const c = safeColor(attrs.color);
          return c ? { style: `color:${c}` } : {};
        },
      },
    };
  },
  parseHTML() { return [{ tag: 'span[style*="color"]' }]; },
  renderHTML({ HTMLAttributes }) { return ['span', HTMLAttributes, 0]; },
  addCommands() {
    return {
      setTextColor: (color: string) => ({ commands }: any) => commands.setMark('textColor', { color }),
      unsetTextColor: () => ({ commands }: any) => commands.unsetMark('textColor'),
    } as any;
  },
});

// ─── Callout node ─────────────────────────────────────────────────────────────────
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      tone: { default: 'note', parseHTML: (el: HTMLElement) => el.getAttribute('data-tone') || 'note', renderHTML: (a: { tone?: string }) => ({ 'data-tone': a.tone || 'note' }) },
      author: { default: null as string | null, parseHTML: (el: HTMLElement) => el.getAttribute('data-author'), renderHTML: (a: { author?: string | null }) => (a.author ? { 'data-author': a.author } : {}) },
    };
  },
  parseHTML() { return [{ tag: 'div[data-callout]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'gw-callout' }), 0]; },
  addCommands() {
    return {
      setCallout: (attrs: { tone?: string; author?: string }) => ({ commands }: any) => commands.wrapIn('callout', attrs),
      toggleCallout: (attrs: { tone?: string; author?: string }) => ({ commands }: any) => commands.toggleWrap('callout', attrs),
    } as any;
  },
});

// ─── Toggle node (collapsible) ──────────────────────────────────────────────────────
export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      summary: { default: 'Details', parseHTML: (el: HTMLElement) => el.getAttribute('data-summary') || 'Details', renderHTML: (a: { summary?: string }) => ({ 'data-summary': a.summary || 'Details' }) },
      open: { default: true, parseHTML: (el: HTMLElement) => el.getAttribute('data-open') !== 'false', renderHTML: (a: { open?: boolean }) => ({ 'data-open': a.open === false ? 'false' : 'true' }) },
      author: { default: null as string | null, parseHTML: (el: HTMLElement) => el.getAttribute('data-author'), renderHTML: (a: { author?: string | null }) => (a.author ? { 'data-author': a.author } : {}) },
    };
  },
  parseHTML() { return [{ tag: 'div[data-toggle]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    const summary = String((node.attrs as { summary?: string }).summary ?? 'Details');
    return ['div', mergeAttributes(HTMLAttributes, { 'data-toggle': '', class: 'gw-toggle' }),
      ['div', { class: 'gw-toggle-summary', contenteditable: 'false' }, `▸ ${summary}`],
      ['div', { class: 'gw-toggle-body' }, 0]];
  },
  addCommands() {
    return {
      setToggle: (attrs: { summary?: string; author?: string }) => ({ commands }: any) => commands.wrapIn('toggle', attrs),
    } as any;
  },
});

// ─── Image node (atom) ──────────────────────────────────────────────────────────────
export const ImageBlock = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null as string | null },
      alt: { default: null as string | null },
      author: { default: null as string | null, parseHTML: (el: HTMLElement) => el.getAttribute('data-author'), renderHTML: (a: { author?: string | null }) => (a.author ? { 'data-author': a.author } : {}) },
    };
  },
  parseHTML() { return [{ tag: 'figure[data-image] img' }, { tag: 'img[src]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as { src?: string; alt?: string };
    const src = safeSrc(attrs.src);
    const inner = src
      ? ['img', mergeAttributes(HTMLAttributes, { src, alt: attrs.alt ?? '' })]
      : ['figcaption', {}, attrs.alt ?? 'image'];
    return ['figure', { 'data-image': '', class: 'gw-image' }, inner];
  },
  addCommands() {
    return {
      setImage: (attrs: { src?: string; alt?: string; author?: string }) => ({ commands }: any) => {
        const src = safeSrc(attrs.src);
        if (!src) return false;
        return commands.insertContent({ type: 'image', attrs: { ...attrs, src } });
      },
    } as any;
  },
});

// ─── Sticker node (block-level atom) ────────────────────────────────────────────────
export const Sticker = Node.create({
  name: 'sticker',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      emoji: { default: '✨' },
      author: { default: null as string | null, parseHTML: (el: HTMLElement) => el.getAttribute('data-author'), renderHTML: (a: { author?: string | null }) => (a.author ? { 'data-author': a.author } : {}) },
    };
  },
  parseHTML() { return [{ tag: 'span[data-sticker]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    const emoji = String((node.attrs as { emoji?: string }).emoji ?? '✨');
    return ['span', mergeAttributes(HTMLAttributes, { 'data-sticker': '', class: 'gw-sticker' }), emoji];
  },
  addCommands() {
    return {
      setSticker: (attrs: { emoji?: string; author?: string }) => ({ commands }: any) => commands.insertContent({ type: 'sticker', attrs: attrs ?? {} }),
    } as any;
  },
});

// ─── Washi divider node (block-level atom) ──────────────────────────────────────────
export const WashiDivider = Node.create({
  name: 'washiDivider',
  group: 'block',
  atom: true,
  addAttributes() {
    return { pattern: { default: 'tape', parseHTML: (el: HTMLElement) => el.getAttribute('data-pattern') || 'tape', renderHTML: (a: { pattern?: string }) => ({ 'data-pattern': a.pattern || 'tape' }) } };
  },
  parseHTML() { return [{ tag: 'div[data-washi]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-washi': '', class: 'gw-washi' })]; },
  addCommands() {
    return {
      setWashiDivider: (attrs: { pattern?: string }) => ({ commands }: any) => commands.insertContent({ type: 'washiDivider', attrs: attrs ?? {} }),
    } as any;
  },
});
