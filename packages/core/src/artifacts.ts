/**
 * @weaveintel/core — Artifact contracts
 */

// ─── Artifact ────────────────────────────────────────────────

export type ArtifactType =
  // Text / document formats
  | 'text' | 'markdown' | 'csv' | 'json' | 'code' | 'html' | 'pdf' | 'report'
  // Visual formats
  | 'image' | 'svg' | 'diagram'
  // Diagram-as-code
  | 'mermaid'
  // Rich / interactive
  | 'react' | 'interactive'
  // Media
  | 'audio' | 'video'
  // Tabular data
  | 'spreadsheet'
  // Escape hatch
  | 'custom';

/** Lifetime scope: session = ephemeral (tied to one chat), user = cross-session */
export type ArtifactScope = 'session' | 'user';

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
  /** Chat/session that produced this artifact (session-scoped artifacts). */
  sessionId?: string;
  /** User who owns this artifact (required for user-scoped artifacts). */
  userId?: string;
  /** Lifetime scope. Defaults to 'session'. */
  scope?: ArtifactScope;
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

export interface ArtifactListFilter {
  type?: ArtifactType | ArtifactType[];
  runId?: string;
  agentId?: string;
  sessionId?: string;
  userId?: string;
  scope?: ArtifactScope;
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface ArtifactStore {
  save(artifact: Omit<Artifact, 'id' | 'createdAt'>): Promise<Artifact>;
  /** Update an existing artifact. Creates a new version record and bumps version number. */
  update(artifactId: string, patch: Partial<Omit<Artifact, 'id' | 'createdAt'>>, changelog?: string): Promise<Artifact>;
  get(artifactId: string): Promise<Artifact | null>;
  list(filter?: ArtifactListFilter): Promise<Artifact[]>;
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
