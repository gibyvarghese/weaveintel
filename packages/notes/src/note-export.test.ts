// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  exportNote, noteToMarkdown, noteToHtmlDocument, noteToWordHtml, noteToJson,
  parseNoteExportBundle, isExportFormat, EXPORT_FORMATS, NOTE_EXPORT_KIND,
  type ExportableNote,
} from './note-export.js';

const NOTE: ExportableNote = {
  title: 'Q3 Launch Plan',
  icon: '🚀',
  doc_json: JSON.stringify({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Goals' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Ship the desktop app.' }] },
      { type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fast' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Offline' }] }] },
      ] },
      { type: 'taskList', content: [
        { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Sign the installer' }] }] },
      ] },
    ],
  }),
};

describe('note-export — formats', () => {
  it('exports Markdown with the title as an H1 and the body content', () => {
    const md = noteToMarkdown(NOTE);
    expect(md).toContain('# Q3 Launch Plan');
    expect(md).toContain('Goals');
    expect(md).toContain('Ship the desktop app.');
    expect(md).toMatch(/[-*] Fast/);
  });

  it('exports a self-contained, print-ready HTML document', () => {
    const html = noteToHtmlDocument(NOTE);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>Q3 Launch Plan</title>');
    expect(html).toContain('@media print');           // PDF-ready
    expect(html).toContain('Ship the desktop app.');
  });

  it('exports Word-compatible HTML (.doc) with the Office namespaces', () => {
    const doc = noteToWordHtml(NOTE);
    expect(doc).toContain('urn:schemas-microsoft-com:office:word');
    expect(doc).toContain('content="Word.Document"');
    expect(doc).toContain('Q3 Launch Plan');
  });

  it('exports a LOSSLESS JSON bundle that round-trips back to the original doc_json', () => {
    const json = noteToJson(NOTE);
    const bundle = parseNoteExportBundle(json)!;
    expect(bundle.kind).toBe(NOTE_EXPORT_KIND);
    expect(bundle.title).toBe('Q3 Launch Plan');
    expect(bundle.icon).toBe('🚀');
    expect(bundle.doc_json).toBe(NOTE.doc_json); // byte-identical → re-import loses nothing
  });

  it('exportNote returns the right filename + MIME per format', () => {
    expect(exportNote(NOTE, 'markdown')).toMatchObject({ filename: 'q3-launch-plan.md', mimeType: expect.stringContaining('text/markdown') });
    expect(exportNote(NOTE, 'html').filename).toBe('q3-launch-plan.html');
    expect(exportNote(NOTE, 'word')).toMatchObject({ filename: 'q3-launch-plan.doc', mimeType: 'application/msword' });
    expect(exportNote(NOTE, 'json').filename).toBe('q3-launch-plan.json');
  });

  it('the format registry + guard agree', () => {
    expect(EXPORT_FORMATS.map((f) => f.key).sort()).toEqual(['html', 'json', 'markdown', 'word']);
    expect(isExportFormat('markdown')).toBe(true);
    expect(isExportFormat('pdf')).toBe(false);
    expect(isExportFormat(42)).toBe(false);
  });
});

describe('note-export — robustness + security (negative/stress)', () => {
  it('tolerates malformed / empty doc_json without throwing', () => {
    const bad: ExportableNote = { title: 'Broken', doc_json: 'not json{' };
    expect(() => exportNote(bad, 'markdown')).not.toThrow();
    expect(() => exportNote(bad, 'html')).not.toThrow();
    expect(noteToMarkdown(bad)).toContain('# Broken');
  });

  it('a blank title falls back to "Untitled note" + a safe filename', () => {
    const n: ExportableNote = { title: '   ', doc_json: '{"type":"doc","content":[]}' };
    expect(noteToMarkdown(n)).toContain('# Untitled note');
    expect(exportNote(n, 'markdown').filename).toBe('note.md');
  });

  it('SECURITY: a hostile title is HTML-escaped in the HTML/Word exports (no injection)', () => {
    const evil: ExportableNote = { title: '<script>alert(1)</script>', doc_json: '{"type":"doc","content":[]}' };
    const html = noteToHtmlDocument(evil);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(noteToWordHtml(evil)).not.toContain('<script>alert(1)</script>');
  });

  it('SECURITY: parseNoteExportBundle rejects non-bundles + corrupt input (fail-safe)', () => {
    expect(parseNoteExportBundle(null)).toBeNull();
    expect(parseNoteExportBundle('not json{')).toBeNull();
    expect(parseNoteExportBundle('{"kind":"something-else","doc_json":"{}"}')).toBeNull();
    expect(parseNoteExportBundle('{"kind":"weavenote-export"}')).toBeNull(); // no doc_json
  });

  it('STRESS: a large note (2,000 paragraphs) exports to every format without throwing', () => {
    const content = Array.from({ length: 2000 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: `Paragraph number ${i}` }] }));
    const big: ExportableNote = { title: 'Huge', doc_json: JSON.stringify({ type: 'doc', content }) };
    for (const f of EXPORT_FORMATS) {
      const out = exportNote(big, f.key);
      expect(out.content.length).toBeGreaterThan(1000);
    }
  });
});
