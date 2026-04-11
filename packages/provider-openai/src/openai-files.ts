/**
 * @weaveintel/provider-openai — OpenAI Files adapter
 *
 * Implements the generic FileStorage contract using OpenAI's Files API.
 * Supports upload (multipart), list, retrieve, download content, and delete.
 */

import type {
  ExecutionContext,
  FileStorage,
  FileUploadRequest,
  FileObject,
  FileListOptions,
} from '@weaveintel/core';
import { deadlineSignal, normalizeError } from '@weaveintel/core';
import {
  type OpenAIProviderOptions,
  DEFAULT_BASE_URL,
  resolveApiKey,
  makeHeaders,
  makeMultipartHeaders,
  openaiGetRequest,
  openaiDeleteRequest,
} from './shared.js';

// ─── Mappers ─────────────────────────────────────────────────

function parseFileObject(raw: Record<string, unknown>): FileObject {
  return {
    id: String(raw['id']),
    filename: String(raw['filename'] ?? ''),
    purpose: String(raw['purpose'] ?? 'assistants') as FileObject['purpose'],
    bytes: Number(raw['bytes'] ?? 0),
    createdAt: Number(raw['created_at'] ?? 0),
    status: String(raw['status'] ?? 'processed') as FileObject['status'],
  };
}

// ─── OpenAI Files adapter ────────────────────────────────────

export function weaveOpenAIFileStorage(
  providerOptions?: OpenAIProviderOptions,
): FileStorage {
  const opts = providerOptions ?? {};
  const apiKey = resolveApiKey(opts);
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const headers = makeHeaders(opts, apiKey);
  const multipartHeaders = makeMultipartHeaders(opts, apiKey);

  return {
    async upload(ctx: ExecutionContext, request: FileUploadRequest): Promise<FileObject> {
      const signal = deadlineSignal(ctx);
      try {
        const form = new FormData();

        // request.file is Buffer | Uint8Array | ReadableStream
        let fileData: Blob;
        if (request.file instanceof ReadableStream) {
          fileData = new Blob([await new Response(request.file).arrayBuffer()]);
        } else {
          const u8 = request.file as Uint8Array;
          fileData = new Blob([u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer]);
        }
        form.append('file', fileData, request.filename ?? 'upload');
        form.append('purpose', request.purpose);

        const res = await fetch(`${baseUrl}/files`, {
          method: 'POST',
          headers: multipartHeaders,
          body: form,
          signal,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`OpenAI Files upload error ${res.status}: ${text}`);
        }
        return parseFileObject((await res.json()) as Record<string, unknown>);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async list(ctx: ExecutionContext, options?: FileListOptions): Promise<FileObject[]> {
      const signal = deadlineSignal(ctx);
      try {
        let path = '/files';
        if (options?.purpose) path += `?purpose=${encodeURIComponent(options.purpose)}`;
        const raw = (await openaiGetRequest(baseUrl, path, headers, signal)) as Record<string, unknown>;
        return ((raw['data'] as unknown[]) ?? []).map((d) => parseFileObject(d as Record<string, unknown>));
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async retrieve(ctx: ExecutionContext, fileId: string): Promise<FileObject> {
      const signal = deadlineSignal(ctx);
      try {
        const raw = (await openaiGetRequest(baseUrl, `/files/${encodeURIComponent(fileId)}`, headers, signal)) as Record<string, unknown>;
        return parseFileObject(raw);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async download(ctx: ExecutionContext, fileId: string): Promise<Uint8Array> {
      const signal = deadlineSignal(ctx);
      try {
        const res = await fetch(`${baseUrl}/files/${encodeURIComponent(fileId)}/content`, {
          method: 'GET',
          headers,
          signal,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`OpenAI Files download error ${res.status}: ${text}`);
        }
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },

    async delete(ctx: ExecutionContext, fileId: string): Promise<void> {
      const signal = deadlineSignal(ctx);
      try {
        await openaiDeleteRequest(baseUrl, `/files/${encodeURIComponent(fileId)}`, headers, signal);
      } catch (err) {
        throw normalizeError(err, 'openai');
      }
    },
  };
}

/** Convenience function */
export function weaveOpenAIFiles(options?: OpenAIProviderOptions): FileStorage {
  return weaveOpenAIFileStorage(options);
}
