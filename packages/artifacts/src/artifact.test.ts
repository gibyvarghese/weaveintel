import { describe, it, expect } from 'vitest';
import {
  createArtifact,
  createArtifactVersion,
  estimateSize,
  inferMimeType,
  inferCodeMime,
  detectImageMime,
} from './artifact.js';

// ─── createArtifact ───────────────────────────────────────────────────────────

describe('createArtifact', () => {
  it('sets a UUIDv7 id', () => {
    const a = createArtifact({ name: 'test', type: 'text', mimeType: 'text/plain', data: 'hello' });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('defaults version to 1 and scope to session', () => {
    const a = createArtifact({ name: 'x', type: 'json', mimeType: 'application/json', data: {} });
    expect(a.version).toBe(1);
    expect(a.scope).toBe('session');
  });

  it('respects explicit scope', () => {
    const a = createArtifact({ name: 'profile', type: 'json', mimeType: 'application/json', data: {}, scope: 'user' });
    expect(a.scope).toBe('user');
  });

  it('includes sessionId and userId when provided', () => {
    const a = createArtifact({ name: 'x', type: 'text', mimeType: 'text/plain', data: '', sessionId: 'sess-1', userId: 'u-1' });
    expect(a.sessionId).toBe('sess-1');
    expect(a.userId).toBe('u-1');
  });

  it('sets createdAt as an ISO string', () => {
    const a = createArtifact({ name: 'x', type: 'text', mimeType: 'text/plain', data: '' });
    expect(() => new Date(a.createdAt)).not.toThrow();
  });

  it('estimates sizeBytes for string data', () => {
    const a = createArtifact({ name: 'x', type: 'text', mimeType: 'text/plain', data: 'hello' });
    expect(a.sizeBytes).toBe(5);
  });
});

// ─── createArtifactVersion ────────────────────────────────────────────────────

describe('createArtifactVersion', () => {
  it('creates a version record with given fields', () => {
    const v = createArtifactVersion('art-1', 2, { result: 42 }, 'second pass');
    expect(v.artifactId).toBe('art-1');
    expect(v.version).toBe(2);
    expect(v.changelog).toBe('second pass');
    expect(v.data).toEqual({ result: 42 });
  });
});

// ─── estimateSize ─────────────────────────────────────────────────────────────

describe('estimateSize', () => {
  it('returns 0 for null', () => expect(estimateSize(null)).toBe(0));
  it('returns 0 for undefined', () => expect(estimateSize(undefined)).toBe(0));
  it('returns byte length for strings', () => expect(estimateSize('hello')).toBe(5));
  it('returns byte length for UTF-8 multibyte strings', () => {
    // '€' is 3 bytes in UTF-8
    expect(estimateSize('€')).toBe(3);
  });
  it('returns buffer length for Buffers', () => {
    expect(estimateSize(Buffer.from([1, 2, 3]))).toBe(3);
  });
  it('returns byteLength for ArrayBuffer', () => {
    const ab = new ArrayBuffer(8);
    expect(estimateSize(ab)).toBe(8);
  });
  it('returns byteLength for Uint8Array', () => {
    expect(estimateSize(new Uint8Array(5))).toBe(5);
  });
  it('returns JSON-serialised byte count for objects', () => {
    const obj = { a: 1 };
    expect(estimateSize(obj)).toBe(Buffer.byteLength(JSON.stringify(obj), 'utf8'));
  });
  it('returns 0 for circular references instead of throwing', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => estimateSize(circular)).not.toThrow();
    expect(estimateSize(circular)).toBe(0);
  });
});

// ─── inferMimeType ────────────────────────────────────────────────────────────

describe('inferMimeType', () => {
  it('returns correct MIME for standard types', () => {
    expect(inferMimeType('json')).toBe('application/json');
    expect(inferMimeType('html')).toBe('text/html');
    expect(inferMimeType('pdf')).toBe('application/pdf');
    expect(inferMimeType('csv')).toBe('text/csv');
    expect(inferMimeType('markdown')).toBe('text/markdown');
    expect(inferMimeType('mermaid')).toBe('text/x-mermaid');
    expect(inferMimeType('svg')).toBe('image/svg+xml');
    expect(inferMimeType('react')).toBe('text/typescript');
  });

  it('refines code MIME from metadata.language', () => {
    expect(inferMimeType('code', { language: 'python' })).toBe('text/x-python');
    expect(inferMimeType('code', { language: 'typescript' })).toBe('text/typescript');
    expect(inferMimeType('code', { language: 'unknown-lang' })).toBe('text/plain');
  });

  it('defaults code to text/plain without language', () => {
    expect(inferMimeType('code')).toBe('text/plain');
  });

  it('image defaults to image/png', () => {
    expect(inferMimeType('image')).toBe('image/png');
  });

  it('audio respects metadata.mimeType override', () => {
    expect(inferMimeType('audio', { mimeType: 'audio/ogg' })).toBe('audio/ogg');
  });

  it('diagram is backwards-compat alias for svg', () => {
    expect(inferMimeType('diagram')).toBe('image/svg+xml');
  });
});

// ─── inferCodeMime ────────────────────────────────────────────────────────────

describe('inferCodeMime', () => {
  it('maps common languages', () => {
    expect(inferCodeMime('typescript')).toBe('text/typescript');
    expect(inferCodeMime('python')).toBe('text/x-python');
    expect(inferCodeMime('rust')).toBe('text/x-rustsrc');
    expect(inferCodeMime('sql')).toBe('application/sql');
    expect(inferCodeMime('shell')).toBe('application/x-sh');
    expect(inferCodeMime('go')).toBe('text/x-go');
  });

  it('is case-insensitive', () => {
    expect(inferCodeMime('TypeScript')).toBe('text/typescript');
    expect(inferCodeMime('PYTHON')).toBe('text/x-python');
  });

  it('returns text/plain for undefined', () => {
    expect(inferCodeMime()).toBe('text/plain');
    expect(inferCodeMime('')).toBe('text/plain');
  });

  it('returns text/plain for unknown language', () => {
    expect(inferCodeMime('brainfuck')).toBe('text/plain');
  });
});

// ─── detectImageMime ──────────────────────────────────────────────────────────

describe('detectImageMime', () => {
  it('detects JPEG from FF D8 FF magic bytes', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    expect(detectImageMime(buf)).toBe('image/jpeg');
  });

  it('detects PNG from 89 50 4E 47 magic bytes', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    expect(detectImageMime(buf)).toBe('image/png');
  });

  it('detects GIF from 47 49 46 magic bytes', () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(detectImageMime(buf)).toBe('image/gif');
  });

  it('detects WebP from RIFF....WEBP magic bytes', () => {
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46,   // RIFF
      0x00, 0x00, 0x00, 0x00,   // file size (ignored)
      0x57, 0x45, 0x42, 0x50,   // WEBP
    ]);
    expect(detectImageMime(buf)).toBe('image/webp');
  });

  it('falls back to image/png for non-binary data', () => {
    expect(detectImageMime('not-binary')).toBe('image/png');
    expect(detectImageMime(null)).toBe('image/png');
    expect(detectImageMime(42)).toBe('image/png');
  });

  it('falls back to image/png for too-short buffer', () => {
    expect(detectImageMime(Buffer.from([0xff, 0xd8]))).toBe('image/png');
  });
});
