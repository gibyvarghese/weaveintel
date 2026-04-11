/**
 * @weaveintel/ui-primitives — Artifact payload builder
 */

import { randomUUID } from 'node:crypto';
import type { ArtifactPayload } from '@weaveintel/core';

export interface CreateArtifactPayloadOptions {
  type: string;
  title: string;
  mimeType: string;
  data: unknown;
  downloadable?: boolean;
  preview?: string;
}

/**
 * Build an ArtifactPayload for streaming to the UI.
 */
export function createArtifactPayload(opts: CreateArtifactPayloadOptions): ArtifactPayload {
  return {
    id: randomUUID(),
    type: opts.type,
    title: opts.title,
    mimeType: opts.mimeType,
    data: opts.data,
    downloadable: opts.downloadable ?? false,
    preview: opts.preview,
  };
}

/**
 * Convenience: JSON artifact.
 */
export function jsonArtifact(title: string, data: unknown): ArtifactPayload {
  return createArtifactPayload({
    type: 'json',
    title,
    mimeType: 'application/json',
    data,
    downloadable: true,
    preview: JSON.stringify(data, null, 2).slice(0, 500),
  });
}

/**
 * Convenience: code artifact.
 */
export function codeArtifact(title: string, code: string, language: string = 'typescript'): ArtifactPayload {
  return createArtifactPayload({
    type: 'code',
    title,
    mimeType: 'text/plain',
    data: { code, language },
    downloadable: true,
    preview: code.slice(0, 300),
  });
}

/**
 * Convenience: CSV artifact.
 */
export function csvArtifact(title: string, csvData: string): ArtifactPayload {
  return createArtifactPayload({
    type: 'csv',
    title,
    mimeType: 'text/csv',
    data: csvData,
    downloadable: true,
    preview: csvData.split('\n').slice(0, 5).join('\n'),
  });
}

/**
 * Convenience: markdown artifact.
 */
export function markdownArtifact(title: string, markdown: string): ArtifactPayload {
  return createArtifactPayload({
    type: 'markdown',
    title,
    mimeType: 'text/markdown',
    data: markdown,
    downloadable: true,
    preview: markdown.slice(0, 300),
  });
}
