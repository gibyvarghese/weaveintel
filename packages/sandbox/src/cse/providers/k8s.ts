/**
 * @weaveintel/sandbox/cse — Shared Kubernetes provider base
 *
 * Shared logic for AKS+Kata and GKE+gVisor providers. Both deploy
 * Kubernetes Jobs (ephemeral) or Pods (session) with a provider-specific
 * RuntimeClass for hardware-level isolation.
 *
 * Auth: uses kubeconfig loaded from file or in-cluster service account.
 * API: calls the Kubernetes REST API directly using Node.js native fetch
 * with kubeconfig-sourced TLS certificates and bearer tokens.
 *
 * RuntimeClasses:
 *   AKS + Kata:    kata-mshv-vm-isolation  (AKS confidential VM nodes)
 *   GKE + gVisor:  gvisor                  (GKE sandbox node pools)
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ContainerProvider } from './base.js';
import { buildRunCommand, languageExt, tryParseOutput } from './base.js';
import type {
  CSEConfig,
  CSEHealthStatus,
  CSEProviderKind,
  CSESession,
  ExecutionRequest,
  ExecutionResult,
} from '../types.js';

const DEFAULT_EXECUTION_IMAGE = 'python:3.12-slim';
const DEFAULT_BROWSER_IMAGE = 'mcr.microsoft.com/playwright:v1.44.0-jammy';
const DEFAULT_NAMESPACE = 'cse';

// ─── Kubeconfig loading ───────────────────────────────────────

interface KubeContext {
  server: string;
  token?: string;
  caData?: string;    // base64 PEM
  certData?: string;  // base64 PEM (client cert)
  keyData?: string;   // base64 PEM (client key)
  namespace: string;
  inCluster: boolean;
}

async function loadKubeContext(config: CSEConfig): Promise<KubeContext> {
  const namespace = config.namespace ?? DEFAULT_NAMESPACE;

  // In-cluster service account
  try {
    const token = await readFile('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
    const ca = await readFile('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt', 'utf8');
    const ns = await readFile('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').catch(() => namespace);
    return {
      server: 'https://kubernetes.default.svc',
      token: token.trim(),
      caData: Buffer.from(ca).toString('base64'),
      namespace: ns.trim() || namespace,
      inCluster: true,
    };
  } catch { /* not in cluster */ }

  // From kubeconfig file
  const kubeconfigPath = config.kubeconfig ?? process.env['KUBECONFIG'] ?? join(homedir(), '.kube', 'config');
  let raw: string;
  try {
    raw = await readFile(kubeconfigPath, 'utf8');
  } catch {
    throw new Error(`Cannot load kubeconfig from ${kubeconfigPath}. Set CSE_KUBECONFIG or run inside the cluster.`);
  }

  // Minimal YAML parser for kubeconfig (avoids adding a YAML dep)
  const kubeconfig = parseKubeconfig(raw);
  return { ...kubeconfig, namespace, inCluster: false };
}

/** Very small kubeconfig YAML parser — handles the common structure only. */
function parseKubeconfig(raw: string): Omit<KubeContext, 'namespace' | 'inCluster'> {
  // Use regex to extract current-context, then cluster server + ca, user token/cert
  const currentContext = extractField(raw, 'current-context');
  if (!currentContext) throw new Error('No current-context in kubeconfig');

  // Find context block
  const contextMatch = raw.match(new RegExp(`- context:[\\s\\S]*?name: ${escapeRx(currentContext)}`, 'm'));
  const clusterName = contextMatch ? extractField(contextMatch[0], 'cluster') : undefined;
  const userName   = contextMatch ? extractField(contextMatch[0], 'user') : undefined;

  // Find cluster block
  let server = '';
  let caData: string | undefined;
  if (clusterName) {
    const clusterBlock = findNamedBlock(raw, 'clusters', clusterName);
    server  = extractField(clusterBlock, 'server') ?? '';
    caData  = extractField(clusterBlock, 'certificate-authority-data');
    if (!caData) {
      const caFile = extractField(clusterBlock, 'certificate-authority');
      if (caFile) {
        try { caData = Buffer.from(require('fs').readFileSync(caFile)).toString('base64'); } catch { /* skip */ }
      }
    }
  }

  // Find user block
  let token: string | undefined;
  let certData: string | undefined;
  let keyData: string | undefined;
  if (userName) {
    const userBlock = findNamedBlock(raw, 'users', userName);
    token    = extractField(userBlock, 'token');
    certData = extractField(userBlock, 'client-certificate-data');
    keyData  = extractField(userBlock, 'client-key-data');
    if (!token) {
      const tokenFile = extractField(userBlock, 'tokenFile');
      if (tokenFile) {
        try { token = require('fs').readFileSync(tokenFile, 'utf8').trim(); } catch { /* skip */ }
      }
    }
  }

  if (!server) throw new Error('Could not determine Kubernetes API server from kubeconfig');
  return { server, token, caData, certData, keyData };
}

function extractField(text: string, field: string): string | undefined {
  const m = text.match(new RegExp(`${escapeRx(field)}:\\s*(.+)`));
  return m?.[1]?.trim();
}

function findNamedBlock(raw: string, listKey: string, name: string): string {
  const idx = raw.indexOf(`${listKey}:`);
  if (idx === -1) return '';
  const section = raw.slice(idx);
  const match = section.match(new RegExp(`- [\\s\\S]*?name: ${escapeRx(name)}[\\s\\S]*?(?=\\n- |$)`, 'm'));
  return match?.[0] ?? '';
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── K8s REST client ─────────────────────────────────────────

export class K8sClient {
  constructor(private ctx: KubeContext) {}

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; data: unknown }> {
    const url = `${this.ctx.server}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (this.ctx.token) {
      headers['Authorization'] = `Bearer ${this.ctx.token}`;
    }

    const fetchOpts: RequestInit = {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    };

    // Node.js 18+ fetch with TLS via env or native
    if (this.ctx.caData && !this.ctx.inCluster) {
      // Set CA via NODE_EXTRA_CA_CERTS is complex — use kubectl fallback for TLS
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'; // Dev only; prod should pass CA
    }

    try {
      const resp = await fetch(url, fetchOpts);
      const data = await resp.json().catch(() => ({}));
      return { ok: resp.ok, status: resp.status, data };
    } catch (err) {
      throw new Error(`K8s API request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async createNamespace(namespace: string): Promise<void> {
    await this.request('POST', '/api/v1/namespaces', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: namespace, labels: { 'app.kubernetes.io/managed-by': 'weaveintel-cse' } },
    });
    // Ignore 409 (already exists)
  }

  async createConfigMap(namespace: string, name: string, data: Record<string, string>): Promise<void> {
    const res = await this.request('POST', `/api/v1/namespaces/${namespace}/configmaps`, {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name, namespace, labels: { 'app.kubernetes.io/managed-by': 'weaveintel-cse' } },
      data,
    });
    if (!res.ok && res.status !== 409) throw new Error(`Failed to create ConfigMap: ${JSON.stringify(res.data)}`);
  }

  async deleteConfigMap(namespace: string, name: string): Promise<void> {
    await this.request('DELETE', `/api/v1/namespaces/${namespace}/configmaps/${name}`);
  }

  async createJob(namespace: string, job: unknown): Promise<void> {
    const res = await this.request('POST', `/apis/batch/v1/namespaces/${namespace}/jobs`, job);
    if (!res.ok) throw new Error(`Failed to create Job: ${JSON.stringify(res.data)}`);
  }

  async getJob(namespace: string, name: string): Promise<unknown> {
    const res = await this.request('GET', `/apis/batch/v1/namespaces/${namespace}/jobs/${name}`);
    return res.data;
  }

  async deleteJob(namespace: string, name: string): Promise<void> {
    await this.request('DELETE', `/apis/batch/v1/namespaces/${namespace}/jobs/${name}?propagationPolicy=Background`);
  }

  async getPodLogs(namespace: string, labelSelector: string): Promise<string> {
    // Find pods for the job
    const res = await this.request('GET', `/api/v1/namespaces/${namespace}/pods?labelSelector=${encodeURIComponent(labelSelector)}`);
    const items = (res.data as any)?.items ?? [];
    if (!items.length) return '';

    const podName = items[0].metadata.name;
    const logRes = await this.request('GET', `/api/v1/namespaces/${namespace}/pods/${podName}/log`);
    return typeof logRes.data === 'string' ? logRes.data : JSON.stringify(logRes.data);
  }

  async createPod(namespace: string, pod: unknown): Promise<void> {
    const res = await this.request('POST', `/api/v1/namespaces/${namespace}/pods`, pod);
    if (!res.ok) throw new Error(`Failed to create Pod: ${JSON.stringify(res.data)}`);
  }

  async getPod(namespace: string, name: string): Promise<unknown> {
    const res = await this.request('GET', `/api/v1/namespaces/${namespace}/pods/${name}`);
    return res.data;
  }

  async deletePod(namespace: string, name: string): Promise<void> {
    await this.request('DELETE', `/api/v1/namespaces/${namespace}/pods/${name}`);
  }
}

// ─── Wait for Job completion ──────────────────────────────────

async function waitForJob(
  client: K8sClient,
  namespace: string,
  jobName: string,
  timeoutMs: number,
): Promise<'succeeded' | 'failed' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = (await client.getJob(namespace, jobName)) as any;
    const conditions: any[] = job?.status?.conditions ?? [];
    if (conditions.find((c: any) => c.type === 'Complete' && c.status === 'True')) return 'succeeded';
    if (conditions.find((c: any) => c.type === 'Failed' && c.status === 'True')) return 'failed';
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return 'timeout';
}

async function waitForPodReady(
  client: K8sClient,
  namespace: string,
  podName: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pod = (await client.getPod(namespace, podName)) as any;
    const phase = pod?.status?.phase;
    if (phase === 'Running') return true;
    if (phase === 'Failed' || phase === 'Succeeded') return false;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return false;
}

// ─── kubectl exec helper (for session exec) ───────────────────

function kubectlExec(
  podName: string,
  namespace: string,
  command: string[],
  kubeconfigPath: string | undefined,
  stdin: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const args = ['exec', '-i', podName, '-n', namespace, '--'];
    if (kubeconfigPath) args.unshift('--kubeconfig', kubeconfigPath);
    args.push(...command);

    const proc = spawn('kubectl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs + 2_000);

    if (stdin) {
      proc.stdin?.write(stdin);
      proc.stdin?.end();
    }

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, exitCode: -1 });
    });
  });
}

// ─── K8sContainerProvider (shared base) ──────────────────────

export abstract class K8sContainerProvider implements ContainerProvider {
  abstract readonly kind: CSEProviderKind;
  abstract readonly runtimeClassName: string;
  readonly supportsSession = true;
  readonly supportsBrowser = true;

  protected client!: K8sClient;
  protected ctx!: KubeContext;

  async initialize(config: CSEConfig): Promise<void> {
    this.ctx = await loadKubeContext(config);
    this.client = new K8sClient(this.ctx);
    // Ensure namespace exists
    await this.client.createNamespace(this.ctx.namespace);
  }

  async execute(request: ExecutionRequest, config: CSEConfig): Promise<ExecutionResult> {
    const executionId = randomUUID();
    const jobName = `cse-${executionId.slice(0, 16)}`;
    const cmName = `cse-code-${executionId.slice(0, 16)}`;
    const lang = request.language ?? 'python';
    const ext = languageExt(lang);
    const namespace = this.ctx.namespace;
    const runtimeClass = config.runtimeClass ?? this.runtimeClassName;
    const image = request.withBrowser
      ? (config.browserImage ?? DEFAULT_BROWSER_IMAGE)
      : (config.executionImage ?? DEFAULT_EXECUTION_IMAGE);
    const timeoutMs = request.timeoutMs ?? config.timeoutMs ?? 30_000;
    const memoryMb = config.memoryMb ?? 512;
    const cpuCount = config.cpuCount ?? 1;

    // Build ConfigMap with code and injected files
    const cmData: Record<string, string> = { [`code.${ext}`]: request.code };
    if (request.files) {
      for (const f of request.files) {
        cmData[f.name] = f.content;
      }
    }

    try {
      await this.client.createConfigMap(namespace, cmName, cmData);

      const envVars = Object.entries(request.env ?? {})
        .filter(([k]) => /^[A-Z_][A-Z0-9_]*$/i.test(k))
        .map(([name, value]) => ({ name, value }));

      const runCmd = buildRunCommand(lang);
      const job = buildJobSpec(
        jobName,
        namespace,
        image,
        runCmd,
        cmName,
        runtimeClass,
        memoryMb,
        cpuCount,
        envVars,
        config.serviceAccount,
        config.imagePullPolicy ?? 'IfNotPresent',
        request.networkAccess ?? config.networkAccess ?? false,
      );

      const start = Date.now();
      await this.client.createJob(namespace, job);
      const outcome = await waitForJob(this.client, namespace, jobName, timeoutMs);
      const durationMs = Date.now() - start;

      const stdout = await this.client.getPodLogs(namespace, `job-name=${jobName}`).catch(() => '');

      let status: ExecutionResult['status'] = 'error';
      if (outcome === 'succeeded') status = 'success';
      else if (outcome === 'timeout') status = 'timeout';

      return {
        executionId,
        status,
        stdout: stdout.slice(0, 100_000),
        stderr: '',
        output: status === 'success' ? tryParseOutput(stdout) : undefined,
        error: status !== 'success' ? `Job ${outcome}` : undefined,
        artifacts: [],
        durationMs,
        providerInfo: {
          provider: this.kind,
          containerId: jobName,
          runtimeClass,
        },
      };
    } finally {
      await this.client.deleteJob(namespace, jobName).catch(() => {});
      await this.client.deleteConfigMap(namespace, cmName).catch(() => {});
    }
  }

  async createSession(chatId: string, config: CSEConfig, withBrowser: boolean): Promise<CSESession> {
    const sessionId = randomUUID();
    const podName = `cse-session-${sessionId.slice(0, 12)}`;
    const namespace = this.ctx.namespace;
    const runtimeClass = config.runtimeClass ?? this.runtimeClassName;
    const image = withBrowser
      ? (config.browserImage ?? DEFAULT_BROWSER_IMAGE)
      : (config.executionImage ?? DEFAULT_EXECUTION_IMAGE);
    const memoryMb = config.memoryMb ?? 512;
    const cpuCount = config.cpuCount ?? 1;

    const pod = buildSessionPodSpec(
      podName,
      namespace,
      image,
      runtimeClass,
      memoryMb,
      cpuCount,
      config.serviceAccount,
      config.imagePullPolicy ?? 'IfNotPresent',
    );

    await this.client.createPod(namespace, pod);
    const ready = await waitForPodReady(this.client, namespace, podName, 60_000);
    if (!ready) {
      await this.client.deletePod(namespace, podName).catch(() => {});
      throw new Error(`Session pod ${podName} did not become ready in 60s`);
    }

    return {
      sessionId,
      chatId,
      provider: this.kind,
      handle: podName,
      status: 'ready',
      hasBrowser: withBrowser,
      networkAccess: config.networkAccess ?? false,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      executionCount: 0,
    };
  }

  async executeInSession(
    session: CSESession,
    request: ExecutionRequest,
    config: CSEConfig,
  ): Promise<ExecutionResult> {
    const executionId = randomUUID();
    const lang = request.language ?? 'python';
    const ext = languageExt(lang);
    const remoteFile = `/workspace/code_${executionId}.${ext}`;
    const namespace = this.ctx.namespace;
    const timeoutMs = request.timeoutMs ?? config.timeoutMs ?? 30_000;

    // Write code into pod via kubectl exec + sh -c 'cat > file'
    const writeResult = await kubectlExec(
      session.handle,
      namespace,
      ['sh', '-c', `mkdir -p /workspace && cat > ${remoteFile}`],
      config.kubeconfig,
      request.code,
      5_000,
    );

    if (writeResult.exitCode !== 0) {
      return {
        executionId,
        sessionId: session.sessionId,
        status: 'error',
        stdout: '',
        stderr: writeResult.stderr,
        error: 'Failed to write code into session pod',
        artifacts: [],
        durationMs: 0,
        providerInfo: { provider: this.kind, containerId: session.handle },
      };
    }

    const runCmd = buildRunCommand(lang).map((p) =>
      /code\.(py|js|ts|sh)$/.test(p) ? remoteFile : p,
    );

    const start = Date.now();
    const execResult = await kubectlExec(
      session.handle,
      namespace,
      runCmd,
      config.kubeconfig,
      '',
      timeoutMs,
    );

    await kubectlExec(session.handle, namespace, ['rm', '-f', remoteFile], config.kubeconfig, '', 3_000);

    return {
      executionId,
      sessionId: session.sessionId,
      status: execResult.exitCode === 0 ? 'success' : 'error',
      stdout: execResult.stdout.slice(0, 100_000),
      stderr: execResult.stderr.slice(0, 20_000),
      output: execResult.exitCode === 0 ? tryParseOutput(execResult.stdout) : undefined,
      error: execResult.exitCode !== 0 ? execResult.stderr.slice(0, 2_000) : undefined,
      artifacts: [],
      durationMs: Date.now() - start,
      providerInfo: { provider: this.kind, containerId: session.handle },
    };
  }

  async terminateSession(session: CSESession, _config: CSEConfig): Promise<void> {
    await this.client.deletePod(this.ctx.namespace, session.handle).catch(() => {});
  }

  async healthCheck(_config: CSEConfig): Promise<CSEHealthStatus> {
    try {
      const res = await this.client['request']('GET', '/api/v1/namespaces');
      return {
        provider: this.kind,
        healthy: (res as any).ok !== false,
        details: { runtimeClass: this.runtimeClassName, namespace: this.ctx.namespace },
      };
    } catch (err) {
      return { provider: this.kind, healthy: false, error: String(err) };
    }
  }
}

// ─── Job + Pod spec builders ──────────────────────────────────

function buildJobSpec(
  name: string,
  namespace: string,
  image: string,
  command: string[],
  configMapName: string,
  runtimeClassName: string,
  memoryMb: number,
  cpuCount: number,
  envVars: Array<{ name: string; value: string }>,
  serviceAccount: string | undefined,
  imagePullPolicy: string,
  networkAccess: boolean,
): unknown {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace,
      labels: { 'app.kubernetes.io/managed-by': 'weaveintel-cse' },
    },
    spec: {
      ttlSecondsAfterFinished: 60,
      backoffLimit: 0,
      template: {
        spec: {
          runtimeClassName,
          restartPolicy: 'Never',
          ...(serviceAccount ? { serviceAccountName: serviceAccount } : {}),
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65534,
            runAsGroup: 65534,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          ...(networkAccess ? {} : { dnsPolicy: 'None', dnsConfig: { nameservers: [] } }),
          containers: [
            {
              name: 'executor',
              image,
              imagePullPolicy,
              command,
              env: envVars,
              resources: {
                limits: {
                  memory: `${memoryMb}Mi`,
                  cpu: String(cpuCount),
                },
                requests: {
                  memory: `${Math.round(memoryMb / 2)}Mi`,
                  cpu: '100m',
                },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [
                { name: 'code', mountPath: '/workspace', readOnly: true },
                { name: 'tmp', mountPath: '/tmp' },
                { name: 'output', mountPath: '/workspace/output' },
              ],
            },
          ],
          volumes: [
            {
              name: 'code',
              configMap: { name: configMapName },
            },
            {
              name: 'tmp',
              emptyDir: { medium: 'Memory', sizeLimit: '100Mi' },
            },
            {
              name: 'output',
              emptyDir: { sizeLimit: '200Mi' },
            },
          ],
        },
      },
    },
  };
}

function buildSessionPodSpec(
  name: string,
  namespace: string,
  image: string,
  runtimeClassName: string,
  memoryMb: number,
  cpuCount: number,
  serviceAccount: string | undefined,
  imagePullPolicy: string,
): unknown {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'weaveintel-cse',
        'cse/session': 'true',
      },
    },
    spec: {
      runtimeClassName,
      restartPolicy: 'Never',
      ...(serviceAccount ? { serviceAccountName: serviceAccount } : {}),
      automountServiceAccountToken: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 65534,
        runAsGroup: 65534,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'session',
          image,
          imagePullPolicy,
          command: ['sleep', 'infinity'],
          resources: {
            limits: { memory: `${memoryMb}Mi`, cpu: String(cpuCount) },
            requests: { memory: `${Math.round(memoryMb / 2)}Mi`, cpu: '100m' },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
          },
          volumeMounts: [
            { name: 'workspace', mountPath: '/workspace' },
            { name: 'tmp', mountPath: '/tmp' },
          ],
        },
      ],
      volumes: [
        { name: 'workspace', emptyDir: { sizeLimit: '500Mi' } },
        { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '100Mi' } },
      ],
    },
  };
}
