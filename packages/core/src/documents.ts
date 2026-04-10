/**
 * @weaveintel/core — Document & content contracts
 *
 * Why: Documents are the universal unit of content across connectors, retrieval,
 * chunking, and memory. A single stable document model prevents conversion
 * overhead between subsystems.
 */

export interface Document {
  readonly id: string;
  readonly content: string;
  readonly metadata: DocumentMetadata;
  readonly source?: SourceReference;
  readonly accessPolicy?: AccessPolicy;
}

export interface DocumentChunk {
  readonly id: string;
  readonly documentId: string;
  readonly content: string;
  readonly index: number;
  readonly metadata: DocumentMetadata;
  readonly embedding?: readonly number[];
  readonly source?: SourceReference;
}

export interface DocumentMetadata {
  readonly [key: string]: unknown;
  readonly title?: string;
  readonly mimeType?: string;
  readonly language?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly author?: string;
  readonly tags?: readonly string[];
  readonly size?: number;
}

export interface SourceReference {
  readonly connector: string;
  readonly uri: string;
  readonly location?: string;
  readonly version?: string;
  readonly retrievedAt: string;
}

export interface Provenance {
  readonly source: SourceReference;
  readonly chunkId: string;
  readonly score?: number;
  readonly method?: string;
}

export interface AccessPolicy {
  readonly tenantId?: string;
  readonly allowedUsers?: readonly string[];
  readonly allowedRoles?: readonly string[];
  readonly classification?: string;
  readonly expiresAt?: string;
}
