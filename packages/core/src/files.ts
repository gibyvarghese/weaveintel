/**
 * @weaveintel/core — File storage contracts
 *
 * Why: Many AI capabilities require file management — vector store ingestion,
 * image editing, audio processing, fine-tuning datasets. This contract
 * abstracts file storage so any provider's file system is consumable.
 */

import type { ExecutionContext } from './context.js';

// ─── File types ──────────────────────────────────────────────

export interface FileUploadRequest {
  readonly file: Buffer | Uint8Array | ReadableStream;
  readonly filename: string;
  readonly purpose: FilePurpose;
  readonly mimeType?: string;
}

export type FilePurpose =
  | 'assistants'
  | 'fine-tune'
  | 'batch'
  | 'vector_store'
  | 'vision'
  | 'user_data'
  | 'evals';

export interface FileObject {
  readonly id: string;
  readonly filename: string;
  readonly purpose: FilePurpose;
  readonly bytes: number;
  readonly createdAt: number;
  readonly status?: 'uploaded' | 'processed' | 'error';
  readonly mimeType?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface FileListOptions {
  readonly purpose?: FilePurpose;
  readonly limit?: number;
  readonly after?: string;
  readonly order?: 'asc' | 'desc';
}

// ─── File storage interface ──────────────────────────────────

export interface FileStorage {
  upload(ctx: ExecutionContext, request: FileUploadRequest): Promise<FileObject>;
  list(ctx: ExecutionContext, options?: FileListOptions): Promise<FileObject[]>;
  retrieve(ctx: ExecutionContext, fileId: string): Promise<FileObject>;
  download(ctx: ExecutionContext, fileId: string): Promise<Buffer | Uint8Array>;
  delete(ctx: ExecutionContext, fileId: string): Promise<void>;
}
