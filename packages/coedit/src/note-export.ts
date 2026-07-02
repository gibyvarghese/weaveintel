// SPDX-License-Identifier: MIT
/**
 * note-export.ts — multi-format note export (weaveNotes Phase 10, sharing/export/polish).
 *
 * Turn a note's `doc_json` into a downloadable file in the format a person actually wants — to keep a
 * copy, hand it to a colleague, or open it in Word. This EXTENDS the serializers this package already
 * owns (`pmToBlocks` → `blocksToMarkdown` / `blocksToHtml`, which already understand every note node,
 * including ink); it does not re-implement them. It adds the wrappers those raw serializers lack:
 *
 *   • **Markdown** (`.md`) — portable plain-text-with-formatting.
 *   • **HTML** (`.html`) — a self-contained, print-ready document (Print → Save as PDF gives a clean PDF).
 *   • **Word** (`.doc`) — Word-compatible HTML that opens natively in Microsoft Word / Google Docs
 *     (the dependency-free path to a Word file; a true binary `.docx` would need a converter like Pandoc).
 *   • **JSON** (`.json`) — a LOSSLESS export bundle (`title` + `icon` + the exact `doc_json`), so a note
 *     can be re-imported with nothing lost — it is just `createNote` with the bundle's `doc_json`.
 *
 * Pure + dependency-light → fully unit-testable in Node. The geneWeave server reuses {@link exportNote}
 * behind a download endpoint + the `export_note` AI tool.
 */
import { pmToBlocks, type NormalBlock } from './prosemirror.js';
import { blocksToMarkdown, blocksToHtml } from './block-markdown.js';

/** A note's identity + content, the input to an export. */
export interface ExportableNote {
  title: string;
  icon?: string | null;
  doc_json: string;
}

/** A finished export: the bytes (always text here) + the right filename + MIME type for a download. */
export interface NoteExport {
  format: ExportFormat;
  filename: string;
  mimeType: string;
  content: string;
}

export type ExportFormat = 'markdown' | 'html' | 'word' | 'json';

export interface ExportFormatSpec {
  key: ExportFormat;
  /** Human label for the menu. */
  label: string;
  /** File extension (no dot). */
  ext: string;
  mimeType: string;
}

/** The export formats weaveNotes offers (drives the UI menu + the server's allow-list). */
export const EXPORT_FORMATS: readonly ExportFormatSpec[] = [
  { key: 'markdown', label: 'Markdown (.md)', ext: 'md', mimeType: 'text/markdown; charset=utf-8' },
  { key: 'html', label: 'Web page (.html)', ext: 'html', mimeType: 'text/html; charset=utf-8' },
  { key: 'word', label: 'Word (.doc)', ext: 'doc', mimeType: 'application/msword' },
  { key: 'json', label: 'Lossless backup (.json)', ext: 'json', mimeType: 'application/json; charset=utf-8' },
];

const FORMAT_BY_KEY = new Map<string, ExportFormatSpec>(EXPORT_FORMATS.map((f) => [f.key, f]));

/** Is this a known export format? */
export function isExportFormat(v: unknown): v is ExportFormat {
  return typeof v === 'string' && FORMAT_BY_KEY.has(v);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Parse a note's `doc_json` into the block list the serializers consume (tolerant of bad input). For
 * a read-only export we do NOT build a CRDT `BlockDoc` (that is O(n²) for large notes) — we map the
 * `pmToBlocks` specs straight to {@link NormalBlock}s (the serializers only read type/attrs/text/marks).
 */
function toBlocks(docJson: string): NormalBlock[] {
  let pm: unknown;
  try { pm = JSON.parse(docJson); } catch { pm = { type: 'doc', content: [] }; }
  return pmToBlocks(pm).map((b): NormalBlock => ({ type: b.type, attrs: b.attrs ?? {}, text: b.text ?? '', marks: b.marks ?? [] }));
}

/** The note's title, trimmed, with a safe fallback. */
function cleanTitle(note: ExportableNote): string {
  return (note.title ?? '').trim() || 'Untitled note';
}

/** Markdown body of a note (with a leading `# Title`). */
export function noteToMarkdown(note: ExportableNote): string {
  const body = blocksToMarkdown(toBlocks(note.doc_json));
  return `# ${cleanTitle(note)}\n\n${body}`.trimEnd() + '\n';
}

/** The inner HTML fragment of a note (no document wrapper). */
export function noteToHtmlFragment(note: ExportableNote): string {
  return blocksToHtml(toBlocks(note.doc_json));
}

/** A print-ready, self-contained HTML document (Print → Save as PDF yields a clean PDF). */
export function noteToHtmlDocument(note: ExportableNote): string {
  const title = cleanTitle(note);
  const fragment = noteToHtmlFragment(note);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, Inter, "Segoe UI", system-ui, sans-serif; line-height: 1.6; color: #14201B; max-width: 46rem; margin: 2.5rem auto; padding: 0 1.25rem; }
  h1, h2, h3 { line-height: 1.25; }
  h1 { font-size: 1.9rem; margin: 0 0 1rem; }
  pre { background: #f4f5f6; padding: 0.85rem 1rem; border-radius: 8px; overflow: auto; }
  code { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 0.92em; }
  blockquote { border-left: 3px solid #b6c2bd; margin: 0; padding: 0.2rem 0 0.2rem 1rem; color: #41514b; }
  img { max-width: 100%; }
  ul, ol { padding-left: 1.4rem; }
  hr { border: none; border-top: 1px solid #e3e8e6; margin: 1.6rem 0; }
  @media print { body { margin: 0; max-width: none; } a { color: inherit; text-decoration: none; } }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
${fragment}
</body>
</html>
`;
}

/** Word-compatible HTML (`.doc`) — opens natively in Microsoft Word and Google Docs. */
export function noteToWordHtml(note: ExportableNote): string {
  const title = cleanTitle(note);
  const fragment = noteToHtmlFragment(note);
  // The MS Office XML namespaces + the `ProgId` meta are what make Word open an HTML file as a document.
  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<meta name="ProgId" content="Word.Document">
<title>${esc(title)}</title>
<style>
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; line-height: 1.5; }
  h1 { font-size: 18pt; }
  pre, code { font-family: Consolas, "Courier New", monospace; }
  blockquote { border-left: 3px solid #b6c2bd; margin: 0; padding-left: 12pt; color: #41514b; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
${fragment}
</body>
</html>
`;
}

/** The lossless JSON export bundle — re-importing it is just `createNote` with `doc_json`. */
export const NOTE_EXPORT_KIND = 'weavenote-export' as const;
export const NOTE_EXPORT_VERSION = 1 as const;

export interface NoteExportBundle {
  kind: typeof NOTE_EXPORT_KIND;
  version: typeof NOTE_EXPORT_VERSION;
  title: string;
  icon: string | null;
  doc_json: string;
}

export function noteToJson(note: ExportableNote): string {
  const bundle: NoteExportBundle = {
    kind: NOTE_EXPORT_KIND, version: NOTE_EXPORT_VERSION,
    title: cleanTitle(note), icon: note.icon ?? null, doc_json: note.doc_json,
  };
  return JSON.stringify(bundle, null, 2);
}

/** Parse a lossless export bundle back (for re-import). Returns null for anything that is not one. */
export function parseNoteExportBundle(raw: string | NoteExportBundle | null | undefined): NoteExportBundle | null {
  if (!raw) return null;
  let b: NoteExportBundle;
  try { b = (typeof raw === 'string' ? JSON.parse(raw) : raw) as NoteExportBundle; } catch { return null; }
  if (!b || b.kind !== NOTE_EXPORT_KIND || typeof b.doc_json !== 'string') return null;
  return { kind: NOTE_EXPORT_KIND, version: NOTE_EXPORT_VERSION, title: typeof b.title === 'string' ? b.title : 'Untitled note', icon: typeof b.icon === 'string' ? b.icon : null, doc_json: b.doc_json };
}

/** A filesystem-safe slug for the download filename. */
function slug(title: string): string {
  const s = (title || 'note').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || 'note';
}

/** Export a note to one format — returns the content + the right filename + MIME for a download. */
export function exportNote(note: ExportableNote, format: ExportFormat): NoteExport {
  const spec = FORMAT_BY_KEY.get(format) ?? FORMAT_BY_KEY.get('markdown')!;
  const content =
    format === 'html' ? noteToHtmlDocument(note) :
    format === 'word' ? noteToWordHtml(note) :
    format === 'json' ? noteToJson(note) :
    noteToMarkdown(note);
  return { format: spec.key, filename: `${slug(note.title)}.${spec.ext}`, mimeType: spec.mimeType, content };
}
