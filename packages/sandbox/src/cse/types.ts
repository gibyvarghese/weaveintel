/**
 * @weaveintel/sandbox — Compute Sandbox Engine (CSE) types
 *
 * CSE enables model-generated code to run in real isolated containers backed
 * by gVisor (GKE), Kata Containers (AKS), Azure Container Instances, Google
 * Cloud Run Jobs, or a local Docker daemon. Sessions are tied to chat IDs so
 * the same container can be reused across turns.
 */

// ─── Provider identifiers ─────────────────────────────────────

export type CSEProviderKind =
  | 'local'       // Local Docker daemon — for development
  | 'aks-kata'    // Azure Kubernetes Service + Kata Containers (VM-level isolation)
  | 'gke-gvisor'  // Google Kubernetes Engine + gVisor (kernel-level isolation)
  | 'aci'         // Azure Container Instances (managed, no k8s)
  | 'cloudrun';   // Google Cloud Run Jobs (managed, gVisor by default)

// ─── Configuration ────────────────────────────────────────────

export interface CSEConfig {
  /** Override auto-detection — leave undefined to auto-detect from env vars. */
  provider?: CSEProviderKind;

  // ── Images ──────────────────────────────────────────────────
  /** OCI image used for code execution (Python, bash, etc.). */
  executionImage?: string;
  /** OCI image with Playwright/Chromium pre-installed for browser automation. */
  browserImage?: string;

  // ── Default limits ──────────────────────────────────────────
  /** Maximum wall-clock time per execution (ms). Default: 30 000. */
  timeoutMs?: number;
  /** Memory limit per container (MiB). Default: 512. */
  memoryMb?: number;
  /** CPU cores allocated per container. Default: 1. */
  cpuCount?: number;
  /** Allow outbound network from the container. Default: false. */
  networkAccess?: boolean;

  // ── Kubernetes shared (AKS/GKE) ─────────────────────────────
  /** Path to kubeconfig file. Defaults to ~/.kube/config or in-cluster. */
  kubeconfig?: string;
  /** Kubernetes namespace to run jobs in. Default: 'cse'. */
  namespace?: string;
  /** Override the RuntimeClass name (kata-mshv-vm-isolation / gvisor). */
  runtimeClass?: string;
  /** ServiceAccount to attach to Pods. */
  serviceAccount?: string;
  /** Image pull policy. Default: 'IfNotPresent'. */
  imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never';

  // ── AKS specific ─────────────────────────────────────────────
  aksSubscriptionId?: string;
  aksResourceGroup?: string;
  aksClusterName?: string;

  // ── GKE specific ─────────────────────────────────────────────
  gkeProjectId?: string;
  gkeCluster?: string;
  gkeRegion?: string;

  // ── Azure shared (AKS + ACI) ─────────────────────────────────
  azureClientId?: string;
  azureClientSecret?: string;
  azureTenantId?: string;
  azureSubscriptionId?: string;

  // ── ACI specific ─────────────────────────────────────────────
  aciResourceGroup?: string;
  aciLocation?: string;

  // ── Google shared (GKE + Cloud Run) ──────────────────────────
  googleProjectId?: string;
  /** Path to service-account JSON or base-64-encoded JSON. */
  googleCredentials?: string;

  // ── Cloud Run specific ───────────────────────────────────────
  cloudRunRegion?: string;

  // ── Session lifecycle ─────────────────────────────────────────
  /** How long a session container stays alive without activity (ms). Default: 600 000 (10 min). */
  sessionTtlMs?: number;
  /** Max concurrent session containers. Default: 20. */
  maxSessions?: number;
}

// ─── Execution request ────────────────────────────────────────

export type ExecutionLanguage = 'python' | 'javascript' | 'typescript' | 'bash' | 'shell';

export interface FileInput {
  /** Path within the container workspace (e.g. 'data.csv'). */
  name: string;
  /** File content — UTF-8 string or base-64 binary. */
  content: string;
  /** Set true when content is base-64-encoded binary. Default: false. */
  binary?: boolean;
}

export interface ExecutionRequest {
  code: string;
  language?: ExecutionLanguage;

  /** Authenticated user identity for tenant/session isolation. */
  userId?: string;

  /** Reuse an existing session container. */
  sessionId?: string;
  /** Chat ID used for session affinity (creates/reuses a session per chat). */
  chatId?: string;

  /** Files to inject into /workspace before execution. */
  files?: FileInput[];
  /** Additional env vars inside the container. Values must not expose secrets. */
  env?: Record<string, string>;

  /** Per-request timeout override (ms). */
  timeoutMs?: number;
  /** Allow outbound network for this execution. */
  networkAccess?: boolean;
  /** Request browser automation (Playwright). Requires browserImage. */
  withBrowser?: boolean;
}

// ─── Execution result ─────────────────────────────────────────

export interface ExecutionArtifactOut {
  /** Relative path within /workspace (e.g. 'output.png'). */
  name: string;
  /** MIME type (e.g. 'image/png'). */
  mimeType: string;
  /** Base-64-encoded file content. */
  data: string;
  sizeBytes: number;
}

export interface ExecutionResult {
  executionId: string;
  /** Session ID if execution ran inside a persistent session. */
  sessionId?: string;
  status: 'success' | 'error' | 'timeout' | 'killed';
  stdout: string;
  stderr: string;
  /** Parsed JSON if the script printed a single JSON object to stdout. */
  output?: unknown;
  error?: string;
  /** Files created in /workspace/output/ during execution. */
  artifacts: ExecutionArtifactOut[];
  durationMs: number;
  memoryUsedMb?: number;
  providerInfo: ExecutionProviderInfo;
}

export interface ExecutionProviderInfo {
  provider: CSEProviderKind;
  /** Container / job / instance identifier. */
  containerId?: string;
  /** Kubernetes node or cloud region. */
  location?: string;
  /** RuntimeClass used (gvisor / kata-mshv-vm-isolation / none). */
  runtimeClass?: string;
}

// ─── Session ─────────────────────────────────────────────────

export type SessionStatus = 'starting' | 'ready' | 'busy' | 'terminated' | 'error';

export interface CSESession {
  sessionId: string;
  userId?: string;
  chatId?: string;
  provider: CSEProviderKind;
  /** Provider-specific handle (container name, pod name, etc.). */
  handle: string;
  status: SessionStatus;
  /** Whether this session has Playwright available. */
  hasBrowser: boolean;
  /** Whether outbound network is enabled for this session container. */
  networkAccess?: boolean;
  createdAt: number;
  lastUsedAt: number;
  executionCount: number;
}

// ─── Health check ─────────────────────────────────────────────

export interface CSEHealthStatus {
  provider: CSEProviderKind;
  healthy: boolean;
  error?: string;
  details?: Record<string, unknown>;
}
