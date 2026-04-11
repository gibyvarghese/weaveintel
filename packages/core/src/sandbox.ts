/**
 * @weaveintel/core — Sandbox execution contracts
 */

// ─── Sandbox ─────────────────────────────────────────────────

export interface Sandbox {
  execute(code: string, policy: SandboxPolicy): Promise<SandboxResult>;
  terminate(executionId: string): Promise<void>;
}

// ─── Policy ──────────────────────────────────────────────────

export interface SandboxPolicy {
  id: string;
  name: string;
  limits: ExecutionLimits;
  allowedModules?: string[];
  deniedModules?: string[];
  networkAccess: boolean;
  fileSystemAccess: 'none' | 'read-only' | 'read-write';
  enabled: boolean;
}

export interface ExecutionLimits {
  maxCpuMs?: number;
  maxMemoryMb?: number;
  maxDurationMs: number;
  maxOutputBytes?: number;
  maxFileSize?: number;
}

// ─── Result ──────────────────────────────────────────────────

export interface SandboxResult {
  executionId: string;
  status: 'success' | 'error' | 'timeout' | 'killed';
  output?: unknown;
  error?: string;
  artifacts: ExecutionArtifact[];
  resourceUsage: {
    cpuMs: number;
    memoryMb: number;
    durationMs: number;
  };
}

export interface ExecutionArtifact {
  name: string;
  type: string;
  data: unknown;
  sizeBytes: number;
}

// ─── Restricted Environment ──────────────────────────────────

export interface RestrictedEnvironment {
  id: string;
  name: string;
  policy: SandboxPolicy;
  status: 'ready' | 'running' | 'terminated';
  createdAt: string;
}
