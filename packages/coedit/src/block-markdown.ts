// SPDX-License-Identifier: MIT
/**
 * @weaveintel/coedit — block → Markdown / HTML serializers (weaveNotes Phase 1).
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

const MD_WRAP: Partial<Record<MarkType, string>> = { bold: '**', italic: '_', code: '`', strike: '~~' };

/** Apply inline marks to a block's text as Markdown (links → `[text](href)`). */
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
      default: parts.push(`<p>${inlineHtml(b.text, b.marks)}</p>`); break;
    }
    i++;
  }
  return parts.join('\n');
}
