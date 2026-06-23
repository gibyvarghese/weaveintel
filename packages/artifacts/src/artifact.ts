import { newUUIDv7 } from '@weaveintel/core';
import type { Artifact, ArtifactType, ArtifactVersion, ArtifactScope } from '@weaveintel/core';

/**
 * Options for creating a new artifact.
 */
export interface CreateArtifactOptions {
  name: string;
  type: ArtifactType;
  mimeType: string;
  data: unknown;
  tags?: string[];
  runId?: string;
  agentId?: string;
  sessionId?: string;
  userId?: string;
  scope?: ArtifactScope;
  metadata?: Record<string, unknown>;
}

/**
 * Create a fully-populated Artifact with a generated id, version 1, and
 * current timestamp.
 */
export function createArtifact(opts: CreateArtifactOptions): Artifact {
  return {
    id: newUUIDv7(),
    name: opts.name,
    type: opts.type,
    mimeType: opts.mimeType,
    data: opts.data,
    sizeBytes: estimateSize(opts.data),
    version: 1,
    tags: opts.tags,
    runId: opts.runId,
    agentId: opts.agentId,
    sessionId: opts.sessionId,
    userId: opts.userId,
    scope: opts.scope ?? 'session',
    metadata: opts.metadata,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create an ArtifactVersion record.
 */
export function createArtifactVersion(
  artifactId: string,
  version: number,
  data: unknown,
  changelog?: string,
): ArtifactVersion {
  return {
    id: newUUIDv7(),
    artifactId,
    version,
    data,
    changelog,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Estimate the byte size of arbitrary data. Safe against circular references.
 */
export function estimateSize(data: unknown): number {
  if (data === null || data === undefined) return 0;
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (data instanceof Uint8Array) return data.byteLength;
  try {
    return Buffer.byteLength(JSON.stringify(data), 'utf8');
  } catch {
    // Circular reference or non-serialisable — return 0 rather than crashing.
    return 0;
  }
}

// ─── Image MIME detection from binary magic bytes ─────────────────────────────

/**
 * Detect the MIME type of an image from its binary magic bytes.
 * Falls back to 'image/png' when the format cannot be determined.
 */
export function detectImageMime(data: unknown): string {
  let bytes: Buffer | null = null;
  if (Buffer.isBuffer(data)) bytes = data;
  else if (data instanceof Uint8Array) bytes = Buffer.from(data);
  else if (data instanceof ArrayBuffer) bytes = Buffer.from(data);

  if (!bytes || bytes.length < 12) return 'image/png';

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  // GIF: 47 49 46
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  // WebP: RIFF????WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  // BMP: 42 4D
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  // TIFF: 49 49 2A 00 or 4D 4D 00 2A
  if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)) return 'image/tiff';

  return 'image/png';
}

// ─── Code MIME by language ────────────────────────────────────────────────────

const CODE_LANGUAGE_MIME: Record<string, string> = {
  typescript: 'text/typescript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  javascript: 'text/javascript',
  js: 'text/javascript',
  jsx: 'text/javascript',
  python: 'text/x-python',
  py: 'text/x-python',
  rust: 'text/x-rustsrc',
  rs: 'text/x-rustsrc',
  go: 'text/x-go',
  java: 'text/x-java-source',
  c: 'text/x-csrc',
  cpp: 'text/x-c++src',
  csharp: 'text/x-csharp',
  cs: 'text/x-csharp',
  sql: 'application/sql',
  sh: 'application/x-sh',
  shell: 'application/x-sh',
  bash: 'application/x-sh',
  html: 'text/html',
  css: 'text/css',
  scss: 'text/x-scss',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  xml: 'application/xml',
  markdown: 'text/markdown',
  md: 'text/markdown',
  r: 'text/x-r',
  ruby: 'text/x-ruby',
  rb: 'text/x-ruby',
  php: 'text/x-php',
  swift: 'text/x-swift',
  kotlin: 'text/x-kotlin',
  kt: 'text/x-kotlin',
};

/**
 * Map a programming language hint to a MIME type for code artifacts.
 * Falls back to 'text/plain' for unknown languages.
 */
export function inferCodeMime(language?: string): string {
  if (!language) return 'text/plain';
  return CODE_LANGUAGE_MIME[language.toLowerCase()] ?? 'text/plain';
}

// ─── MIME map ─────────────────────────────────────────────────────────────────

const MIME_MAP: Record<ArtifactType, string> = {
  text: 'text/plain',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  code: 'text/plain',               // refined by metadata.language via inferCodeMime
  html: 'text/html',
  pdf: 'application/pdf',
  report: 'text/html',
  image: 'image/png',               // refined at runtime by detectImageMime
  svg: 'image/svg+xml',
  diagram: 'image/svg+xml',         // backwards-compat alias for svg
  mermaid: 'text/x-mermaid',
  react: 'text/typescript',         // TSX source
  interactive: 'text/html',
  audio: 'audio/mpeg',              // refined by metadata.mimeType
  video: 'video/mp4',               // refined by metadata.mimeType
  spreadsheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  custom: 'application/octet-stream',
};

/**
 * Map an ArtifactType to a default MIME type string.
 * For 'code' pass language via metadata; use inferCodeMime() directly for more control.
 * For 'image' use detectImageMime() on binary data to get the precise MIME.
 */
export function inferMimeType(type: ArtifactType, metadata?: Record<string, unknown>): string {
  if (type === 'code' && metadata?.['language']) {
    return inferCodeMime(String(metadata['language']));
  }
  if (type === 'audio' && metadata?.['mimeType']) return String(metadata['mimeType']);
  if (type === 'video' && metadata?.['mimeType']) return String(metadata['mimeType']);
  return MIME_MAP[type] ?? 'application/octet-stream';
}
