// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryCommentManager, renderCommentMarkdown } from './run-comment.js';
import { commentManagerContract } from './run-comment-contract.js';
import {
  createInMemoryAnnotationManager,
  normalizeAnnotationValue,
  summarizeAnnotations,
  annotationsToEvalExamples,
  type RunAnnotation,
} from './run-annotation.js';
import { annotationManagerContract } from './run-annotation-contract.js';

commentManagerContract(() => createInMemoryCommentManager(), { describe, it, beforeEach, expect } as never);
annotationManagerContract(() => createInMemoryAnnotationManager(), { describe, it, beforeEach, expect } as never);

describe('renderCommentMarkdown — XSS / safety', () => {
  it('escapes raw HTML and dangerous URLs', () => {
    expect(renderCommentMarkdown('<img src=x onerror=alert(1)>')).not.toContain('<img');
    // A javascript: URL is NEVER linkified — it stays inert escaped text (no <a href>).
    const js = renderCommentMarkdown('[click](javascript:alert(1))');
    expect(js).not.toContain('href="javascript:');
    expect(js).not.toContain('<a ');
    expect(renderCommentMarkdown('[click](data:text/html,evil)')).not.toContain('<a '); // not linkified
    expect(renderCommentMarkdown("'\"<>&")).toContain('&lt;'); // all escaped
  });
  it('linkifies only http(s) with safe rel', () => {
    const html = renderCommentMarkdown('see [docs](https://example.com/x)');
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
  it('applies bold/italic/code/mention/newlines', () => {
    expect(renderCommentMarkdown('**b** *i* `c`')).toBe('<strong>b</strong> <em>i</em> <code>c</code>');
    expect(renderCommentMarkdown('hi @alice')).toContain('<span class="mention">@alice</span>');
    expect(renderCommentMarkdown('a\nb')).toBe('a<br>b');
  });
  it('caps length (anti-abuse)', () => {
    expect(renderCommentMarkdown('x'.repeat(50_000)).length).toBeLessThan(11_000);
  });
});

describe('annotation helpers', () => {
  it('normalizeAnnotationValue handles booleans + numerics', () => {
    expect(normalizeAnnotationValue({ dataType: 'boolean', value: 1, stringValue: null })).toEqual({ value: 1, stringValue: 'true' });
    expect(normalizeAnnotationValue({ dataType: 'boolean', value: null, stringValue: 'false' })).toEqual({ value: 0, stringValue: 'false' });
    expect(normalizeAnnotationValue({ dataType: 'numeric', value: 4, stringValue: null })).toEqual({ value: 4, stringValue: null });
  });
  it('summarizeAnnotations averages numeric scores per name', () => {
    const anns = [
      { name: 'help', value: 4 }, { name: 'help', value: 2 }, { name: 'thumbs', value: 1 },
    ] as RunAnnotation[];
    const sum = summarizeAnnotations(anns);
    expect(sum.find((s) => s.name === 'help')).toEqual({ name: 'help', count: 2, average: 3 });
  });
  it('annotationsToEvalExamples maps the score schema to dataset examples', () => {
    const ex = annotationsToEvalExamples([{ runId: 'r1', partId: 'tool-1', name: 'correct', value: 1, stringValue: 'true', comment: 'ok', source: 'human' } as RunAnnotation]);
    expect(ex[0]).toMatchObject({ runId: 'r1', partId: 'tool-1', name: 'correct', score: 1, source: 'human' });
  });
});

describe('CommentManager — stress & isolation (in-memory)', () => {
  let mgr = createInMemoryCommentManager();
  beforeEach(() => { mgr = createInMemoryCommentManager(); });
  it('handles a large thread', async () => {
    const r = await mgr.create({ id: 'root', runId: 'r1', tenantId: 'tA', authorId: 'a', body: 'start', anchor: { partId: 'text-1', createdAtSeq: 1 } });
    for (let i = 0; i < 200; i++) await mgr.create({ id: `c${i}`, runId: 'r1', tenantId: 'tA', authorId: 'a', body: `r${i}`, parentId: r.id, anchor: { partId: 'text-1', createdAtSeq: 1 } });
    expect((await mgr.listThread(r.id)).length).toBe(201);
  });
});
