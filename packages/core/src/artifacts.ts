/**
 * @weaveintel/core — Artifact contracts
 */

// ─── Artifact ────────────────────────────────────────────────

export type ArtifactType = 'text' | 'csv' | 'json' | 'html' | 'markdown' | 'image' | 'pdf' | 'diagram' | 'code' | 'report' | 'custom';

export interface Artifact {
  id: string;
  name: string;
  type: ArtifactType;
  mimeType: string;
  data: unknown;
  sizeBytes?: number;
  version: number;
  tags?: string[];
  runId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

export interface ArtifactVersion {
  id: string;
  artifactId: string;
  version: number;
  data: unknown;
  changelog?: string;
  createdAt: string;
}

// ─── Store ───────────────────────────────────────────────────

export interface ArtifactStore {
  save(artifact: Omit<Artifact, 'id' | 'createdAt'>): Promise<Artifact>;
  get(artifactId: string): Promise<Artifact | null>;
  list(filter?: { type?: ArtifactType; runId?: string; agentId?: string; tags?: string[] }): Promise<Artifact[]>;
  delete(artifactId: string): Promise<void>;
  getVersions(artifactId: string): Promise<ArtifactVersion[]>;
}

// ─── Reference ───────────────────────────────────────────────

export interface ArtifactReference {
  artifactId: string;
  version?: number;
  label?: string;
}

// ─── Policy ──────────────────────────────────────────────────

export interface ArtifactPolicy {
  id: string;
  name: string;
  maxSizeBytes?: number;
  allowedTypes?: ArtifactType[];
  retentionDays?: number;
  requireVersioning: boolean;
  enabled: boolean;
}
