import { randomUUID } from 'node:crypto';
import type { Artifact, ArtifactType, ArtifactVersion } from '@weaveintel/core';

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
  metadata?: Record<string, unknown>;
}

/**
 * Create a fully-populated Artifact with a generated id, version 1, and
 * current timestamp.
 */
export function createArtifact(opts: CreateArtifactOptions): Artifact {
  return {
    id: randomUUID(),
    name: opts.name,
    type: opts.type,
    mimeType: opts.mimeType,
    data: opts.data,
    sizeBytes: estimateSize(opts.data),
    version: 1,
    tags: opts.tags,
    runId: opts.runId,
    agentId: opts.agentId,
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
    id: randomUUID(),
    artifactId,
    version,
    data,
    changelog,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Estimate the byte size of arbitrary data.
 */
export function estimateSize(data: unknown): number {
  if (data === null || data === undefined) return 0;
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (data instanceof Uint8Array) return data.byteLength;
  // Fall back to JSON serialisation length for objects / arrays / numbers / booleans
  return Buffer.byteLength(JSON.stringify(data), 'utf8');
}

const MIME_MAP: Record<ArtifactType, string> = {
  text: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  markdown: 'text/markdown',
  image: 'image/png',
  pdf: 'application/pdf',
  diagram: 'image/svg+xml',
  code: 'text/plain',
  report: 'text/html',
  custom: 'application/octet-stream',
};

/**
 * Map an ArtifactType to a reasonable MIME type string.
 */
export function inferMimeType(type: ArtifactType): string {
  return MIME_MAP[type] ?? 'application/octet-stream';
}
