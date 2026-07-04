// SPDX-License-Identifier: MIT
/**
 * @weaveintel/coedit — block → Markdown / HTML serializers.
 *
 * Turn a {@link BlockDoc}'s rendered blocks into Markdown (for feeding a note to
 * an AI model, and for the Phase 4 "emit a note as an artifact" flow) or sanitized
 * HTML (for a read-only preview / public share). Pure + zero-dependency.
 *
 * --- For someone new to this ---
 * Markdown is plain text with light formatting: `# Heading`, `- bullet`,
 * `**bold**`. Models speak Markdown natively, so converting a note to Markdown is
 * how the AI "reads" it. The HTML version is what a browser would show — and we
 * escape everything first so a note can never smuggle in a script.
 */
import type { NormalBlock } from './prosemirror.js';
import type { MarkType } from './block-doc.js';

// ─── Markdown ─────────────────────────────────────────────────────────────────────

const MD_WRAP: Partial<Record<MarkType, string>> = { bold: '**', italic: '_', code: '`', strike: '~~', highlight: '==' };

/**
 * Allow ONLY a CSS colour we are certain is inert: a hex literal, an `rgb[a]()` /
 * `hsl[a]()` functional notation, or a short safe named set. Anything else (notably
 * `url(...)`, `expression(...)`, or anything with a `;`/`}`) returns `''` so a note
 * can never smuggle CSS into a shared HTML preview through a colour mark.
 */
export function safeCssColor(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (s.length > 32) return '';
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^rgba?\(\s*[\d.\s,%]+\)$/.test(s)) return s;
  if (/^hsla?\(\s*[\d.\s,%]+\)$/.test(s)) return s;
  if (/^[a-zA-Z]{3,20}$/.test(s)) return s.toLowerCase(); // a named colour (e.g. "coral"); letters only
  return '';
}

/** Apply inline marks to a block's text as Markdown (links → `[text](href)`, highlight → `==text==`). */
function inlineMarkdown(text: string, marks: NormalBlock['marks']): string {
  if (marks.length === 0) return text;
  // Insert wrap tokens at boundaries (process right-to-left so offsets stay valid).
  type Edit = { at: number; insert: string };
  const edits: Edit[] = [];
  for (const m of marks) {
    if (m.type === 'link') { edits.push({ at: m.from, insert: '[' }); edits.push({ at: m.to, insert: `](${m.value ?? ''})` }); }
    else { const w = MD_WRAP[m.type]; if (w) { edits.push({ at: m.from, insert: w }); edits.push({ at: m.to, insert: w }); } }
  }
  edits.sort((a, b) => b.at - a.at || b.insert.length - a.insert.length);
  let out = text;
  for (const e of edits) out = out.slice(0, e.at) + e.insert + out.slice(e.at);
  return out;
}

/** A short, plain-text summary of a diagram block (title + node labels) — useful AI context. */
function diagramSummary(attrs: NormalBlock['attrs']): string {
  const scene = attrs['scene'] as { title?: string; nodes?: Array<{ label?: string }> } | undefined;
  const title = (scene?.title ?? (typeof attrs['title'] === 'string' ? attrs['title'] : '')) || 'Diagram';
  const labels = Array.isArray(scene?.nodes) ? scene!.nodes.map((n) => (typeof n?.label === 'string' ? n.label : '')).filter(Boolean) : [];
  return labels.length ? `[diagram: ${title} — ${labels.join(' → ')}]` : `[diagram: ${title}]`;
}

/** Serialize blocks to GitHub-flavoured Markdown. */
export function blocksToMarkdown(blocks: NormalBlock[]): string {
  const lines: string[] = [];
  let orderedIndex = 0;
  for (const b of blocks) {
    const inline = inlineMarkdown(b.text, b.marks);
    switch (b.type) {
      case 'heading': lines.push(`${'#'.repeat(Math.min(6, Math.max(1, Number(b.attrs['level'] ?? 1))))} ${inline}`); orderedIndex = 0; break;
      case 'bulletListItem': lines.push(`- ${inline}`); orderedIndex = 0; break;
      case 'orderedListItem': lines.push(`${++orderedIndex}. ${inline}`); break;
      case 'taskItem': lines.push(`- [${b.attrs['checked'] === true ? 'x' : ' '}] ${inline}`); orderedIndex = 0; break;
      case 'blockquote': lines.push(`> ${inline}`); orderedIndex = 0; break;
      case 'codeBlock': lines.push('```' + (typeof b.attrs['language'] === 'string' ? b.attrs['language'] : '')); lines.push(b.text); lines.push('```'); orderedIndex = 0; break;
      case 'divider': lines.push('---'); orderedIndex = 0; break;
      // Phase 1 creative blocks.
      case 'callout': { const tone = typeof b.attrs['tone'] === 'string' ? b.attrs['tone'] : 'note'; lines.push(`> [!${String(tone).toUpperCase()}]`); for (const ln of inline.split('\n')) lines.push(`> ${ln}`); orderedIndex = 0; break; }
      case 'toggle': { const summary = typeof b.attrs['summary'] === 'string' && b.attrs['summary'] ? b.attrs['summary'] : 'Details'; lines.push(`**${summary}**`); if (inline) lines.push(inline); orderedIndex = 0; break; }
      case 'image': { const src = typeof b.attrs['src'] === 'string' ? b.attrs['src'] : ''; const alt = typeof b.attrs['alt'] === 'string' ? b.attrs['alt'] : ''; lines.push(`![${alt}](${src})`); orderedIndex = 0; break; }
      case 'sticker': { const emoji = typeof b.attrs['emoji'] === 'string' ? b.attrs['emoji'] : '✨'; lines.push(emoji); orderedIndex = 0; break; }
      case 'washiDivider': lines.push('---'); orderedIndex = 0; break;
      // Phase 4 creative atoms — a textual summary so the AI understands them when reading the note.
      case 'diagram': lines.push(diagramSummary(b.attrs)); orderedIndex = 0; break;
      case 'inkCanvas': lines.push('[ink drawing]'); orderedIndex = 0; break;
      default: lines.push(inline); orderedIndex = 0; break;
    }
  }
  return lines.join('\n');
}

// ─── HTML (sanitized) ─────────────────────────────────────────────────────────────

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s: string): string { return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!); }

const HTML_TAG: Partial<Record<MarkType, string>> = { bold: 'strong', italic: 'em', code: 'code', strike: 's', underline: 'u' };

/** Apply inline marks as safe HTML (everything escaped first; links http(s) only). */
function inlineHtml(text: string, marks: NormalBlock['marks']): string {
  type Edit = { at: number; insert: string; open: boolean };
  const edits: Edit[] = [];
  for (const m of marks) {
    if (m.type === 'link') {
      const href = typeof m.value === 'string' && /^https?:\/\//.test(m.value) ? m.value : '#';
      edits.push({ at: m.from, insert: `<a href="${esc(href)}" rel="noopener noreferrer nofollow">`, open: true });
      edits.push({ at: m.to, insert: '</a>', open: false });
    } else if (m.type === 'highlight') {
      const bg = safeCssColor(m.value);
      edits.push({ at: m.from, insert: bg ? `<mark style="background:${bg}">` : '<mark>', open: true });
      edits.push({ at: m.to, insert: '</mark>', open: false });
    } else if (m.type === 'textColor') {
      const fg = safeCssColor(m.value);
      edits.push({ at: m.from, insert: fg ? `<span style="color:${fg}">` : '<span>', open: true });
      edits.push({ at: m.to, insert: '</span>', open: false });
    } else { const tag = HTML_TAG[m.type]; if (tag) { edits.push({ at: m.from, insert: `<${tag}>`, open: true }); edits.push({ at: m.to, insert: `</${tag}>`, open: false }); } }
  }
  // Build by walking characters and inserting opens (asc) / closes (asc) at boundaries.
  let out = '';
  for (let i = 0; i <= text.length; i++) {
    for (const e of edits.filter((x) => !x.open && x.at === i)) out += e.insert;
    for (const e of edits.filter((x) => x.open && x.at === i)) out += e.insert;
    if (i < text.length) out += esc(text[i]!);
  }
  return out;
}

/** Serialize blocks to sanitized HTML (read-only preview / public share). */
export function blocksToHtml(blocks: NormalBlock[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i]!;
    if (b.type === 'bulletListItem' || b.type === 'orderedListItem' || b.type === 'taskItem') {
      const tag = b.type === 'orderedListItem' ? 'ol' : 'ul';
      const items: string[] = [];
      while (i < blocks.length && blocks[i]!.type === b.type) {
        const item = blocks[i]!;
        const prefix = item.type === 'taskItem' ? `<input type="checkbox" disabled${item.attrs['checked'] === true ? ' checked' : ''}> ` : '';
        items.push(`<li>${prefix}${inlineHtml(item.text, item.marks)}</li>`);
        i++;
      }
      parts.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    switch (b.type) {
      case 'heading': { const lvl = Math.min(6, Math.max(1, Number(b.attrs['level'] ?? 1))); parts.push(`<h${lvl}>${inlineHtml(b.text, b.marks)}</h${lvl}>`); break; }
      case 'blockquote': parts.push(`<blockquote>${inlineHtml(b.text, b.marks)}</blockquote>`); break;
      case 'codeBlock': parts.push(`<pre><code>${esc(b.text)}</code></pre>`); break;
      case 'divider': parts.push('<hr>'); break;
      // Phase 1 creative blocks (all attribute values escaped / colour-validated).
      case 'callout': { const tone = typeof b.attrs['tone'] === 'string' ? esc(b.attrs['tone']) : 'note'; parts.push(`<div class="gw-callout gw-callout-${tone}"><p>${inlineHtml(b.text, b.marks)}</p></div>`); break; }
      case 'toggle': { const summary = typeof b.attrs['summary'] === 'string' && b.attrs['summary'] ? esc(b.attrs['summary']) : 'Details'; parts.push(`<details${b.attrs['open'] === true ? ' open' : ''}><summary>${summary}</summary><p>${inlineHtml(b.text, b.marks)}</p></details>`); break; }
      case 'image': { const src = typeof b.attrs['src'] === 'string' && /^https?:\/\//.test(b.attrs['src']) ? b.attrs['src'] : ''; const alt = typeof b.attrs['alt'] === 'string' ? esc(b.attrs['alt']) : ''; parts.push(src ? `<figure><img src="${esc(src)}" alt="${alt}"></figure>` : `<figure><figcaption>${alt}</figcaption></figure>`); break; }
      case 'sticker': { const emoji = typeof b.attrs['emoji'] === 'string' ? esc(b.attrs['emoji']) : '✨'; parts.push(`<span class="gw-sticker">${emoji}</span>`); break; }
      case 'washiDivider': parts.push('<hr class="gw-washi">'); break;
      // Phase 4 atoms — a safe placeholder for the public-share render (the editor draws the real SVG).
      case 'diagram': parts.push(`<figure class="gw-diagram-embed"><figcaption>${esc(diagramSummary(b.attrs))}</figcaption></figure>`); break;
      case 'inkCanvas': parts.push('<figure class="gw-ink-embed"><figcaption>Ink drawing</figcaption></figure>'); break;
      default: parts.push(`<p>${inlineHtml(b.text, b.marks)}</p>`); break;
    }
    i++;
  }
  return parts.join('\n');
}
