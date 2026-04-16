/**
 * @weaveintel/sandbox/cse — Google Cloud Run Jobs provider
 *
 * Runs code as Google Cloud Run Jobs — a serverless compute offering where
 * each job gets a fresh container that executes to completion and exits.
 * Cloud Run inherently uses gVisor (runsc) as its container runtime, so
 * every workload is already kernel-isolated without additional configuration.
 *
 * Required env vars:
 *   CLOUDRUN_PROJECT_ID (or GKE_PROJECT_ID / GOOGLE_PROJECT_ID)
 *   CLOUDRUN_REGION (default: us-central1)
 *   GOOGLE_APPLICATION_CREDENTIALS — path to service account JSON
 *     OR GOOGLE_CREDENTIALS_JSON — base64-encoded service account JSON
 *
 * Note: Cloud Run Jobs API uses run.googleapis.com/v2.
 * Sessions are not supported — each execution is ephemeral.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSign } from 'node:crypto';
import type { ContainerProvider } from './base.js';
import { buildRunCommand, languageExt, tryParseOutput } from './base.js';
import type {
  CSEConfig,
  CSEHealthStatus,
  CSESession,
  ExecutionRequest,
  ExecutionResult,
} from '../types.js';

const DEFAULT_EXECUTION_IMAGE = 'python:3.12-slim';
const CLOUDRUN_API = 'https://run.googleapis.com/v2';
const GOOGLE_AUTH_URL = 'https://oauth2.googleapis.com/token';

// ─── Google service-account JWT auth ─────────────────────────

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

interface GoogleToken {
  access_token: string;
  expires_in: number;
  obtainedAt: number;
}

let cachedGToken: GoogleToken | null = null;
let cachedSA: ServiceAccountKey | null = null;

async function loadServiceAccount(config: CSEConfig): Promise<ServiceAccountKey> {
  if (cachedSA) return cachedSA;

  const credEnv = config.googleCredentials ?? process.env['GOOGLE_CREDENTIALS_JSON'];
  const credFile = process.env['GOOGLE_APPLICATION_CREDENTIALS'];

  let raw: string;
  if (credEnv) {
    // May be base64-encoded or raw JSON
    raw = credEnv.trimStart().startsWith('{')
      ? credEnv
      : Buffer.from(credEnv, 'base64').toString('utf8');
  } else if (credFile) {
    raw = await readFile(credFile, 'utf8');
  } else {
    throw new Error(
      'Google credentials required: set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CREDENTIALS_JSON',
    );
  }

  cachedSA = JSON.parse(raw) as ServiceAccountKey;
  return cachedSA;
}

async function getGoogleToken(config: CSEConfig): Promise<string> {
  const now = Date.now();
  if (cachedGToken && now < cachedGToken.obtainedAt + (cachedGToken.expires_in - 60) * 1_000) {
    return cachedGToken.access_token;
  }

  const sa = await loadServiceAccount(config);

  // Build JWT assertion
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const iat = Math.floor(now / 1_000);
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: GOOGLE_AUTH_URL,
    iat,
    exp: iat + 3600,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
  })).toString('base64url');

  const signingInput = `${header}.${payload}`;
  const sign = createSign('SHA256');
  sign.update(signingInput);
  const signature = sign.sign(sa.private_key, 'base64url');
  const jwt = `${signingInput}.${signature}`;

  const resp = await fetch(GOOGLE_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Google auth failed: ${err}`);
  }

  const data = (await resp.json()) as { access_token: string; expires_in: number };
  cachedGToken = { ...data, obtainedAt: now };
  return data.access_token;
}

async function crRequest(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const resp = await fetch(`${CLOUDRUN_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: unknown;
  try { data = await resp.json(); } catch { data = {}; }
  return { ok: resp.ok, status: resp.status, data };
}

// ─── Provider ────────────────────────────────────────────────

export class CloudRunJobsProvider implements ContainerProvider {
  readonly kind = 'cloudrun' as const;
  readonly supportsSession = false;
  readonly supportsBrowser = false;

  async initialize(config: CSEConfig): Promise<void> {
    await getGoogleToken(config);
  }

  async execute(request: ExecutionRequest, config: CSEConfig): Promise<ExecutionResult> {
    const executionId = randomUUID();
    const jobId = `cse-${executionId.slice(0, 16)}`;

    const projectId = config.googleProjectId
      ?? config.gkeProjectId
      ?? process.env['CLOUDRUN_PROJECT_ID']
      ?? process.env['GKE_PROJECT_ID']
      ?? process.env['GOOGLE_PROJECT_ID'];

    const region = config.cloudRunRegion
      ?? process.env['CLOUDRUN_REGION']
      ?? 'us-central1';

    if (!projectId) throw new Error('CLOUDRUN_PROJECT_ID is required for Cloud Run Jobs provider');

    const image = config.executionImage ?? DEFAULT_EXECUTION_IMAGE;
    const timeoutMs = request.timeoutMs ?? config.timeoutMs ?? 30_000;
    const memoryMb = config.memoryMb ?? 512;
    const cpuCount = config.cpuCount ?? 1;
    const lang = request.language ?? 'python';
    const ext = languageExt(lang);

    // Inject code via env var (base64), decode and run in container
    const codeB64 = Buffer.from(request.code).toString('base64');
    const runCmd = buildRunCommand(lang);
    const entryShell = `echo "$CSE_CODE_B64" | base64 -d > /tmp/code.${ext} && ${runCmd.join(' ').replace(`/workspace/code.${ext}`, `/tmp/code.${ext}`)}`;

    const envVars: Array<{ name: string; value: string }> = [
      { name: 'CSE_CODE_B64', value: codeB64 },
      ...Object.entries(request.env ?? {})
        .filter(([k]) => /^[A-Z_][A-Z0-9_]*$/i.test(k))
        .map(([name, value]) => ({ name, value })),
    ];

    const token = await getGoogleToken(config);
    const parent = `projects/${projectId}/locations/${region}`;

    // Create Cloud Run Job
    const jobBody = {
      template: {
        taskCount: 1,
        template: {
          maxRetries: 0,
          timeout: `${Math.ceil(timeoutMs / 1_000)}s`,
          containers: [
            {
              image,
              command: ['sh', '-c', entryShell],
              env: envVars,
              resources: {
                limits: {
                  cpu: String(cpuCount * 1000) + 'm',
                  memory: `${memoryMb}Mi`,
                },
              },
            },
          ],
          // Cloud Run uses gVisor by default — no explicit sandbox config needed
          executionEnvironment: 'EXECUTION_ENVIRONMENT_GEN2',
        },
      },
    };

    const start = Date.now();
    const createRes = await crRequest(
      'POST',
      `/${parent}/jobs?jobId=${jobId}`,
      token,
      jobBody,
    );

    if (!createRes.ok) {
      return {
        executionId,
        status: 'error',
        stdout: '',
        stderr: JSON.stringify(createRes.data),
        error: `Cloud Run Job creation failed: HTTP ${createRes.status}`,
        artifacts: [],
        durationMs: Date.now() - start,
        providerInfo: { provider: 'cloudrun', location: region },
      };
    }

    // Trigger job execution
    const runRes = await crRequest('POST', `/${parent}/jobs/${jobId}:run`, token, {});
    if (!runRes.ok) {
      await crRequest('DELETE', `/${parent}/jobs/${jobId}`, token).catch(() => {});
      return {
        executionId,
        status: 'error',
        stdout: '',
        stderr: JSON.stringify(runRes.data),
        error: `Cloud Run Job trigger failed: HTTP ${runRes.status}`,
        artifacts: [],
        durationMs: Date.now() - start,
        providerInfo: { provider: 'cloudrun', location: region },
      };
    }

    // Poll execution
    const executionName = (runRes.data as any)?.name;
    const deadline = Date.now() + timeoutMs + 30_000;
    let finalStatus: ExecutionResult['status'] = 'error';

    while (executionName && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3_000));
      const execRes = await crRequest('GET', `/${executionName}`, token);
      const execData = execRes.data as any;
      const conditions: any[] = execData?.conditions ?? [];
      const ready = conditions.find((c: any) => c.type === 'Ready');
      const succeeded = conditions.find((c: any) => c.type === 'Succeeded');

      if (succeeded?.status === 'True') { finalStatus = 'success'; break; }
      if (ready?.status === 'False') { finalStatus = 'error'; break; }
    }

    if (Date.now() >= deadline) finalStatus = 'timeout';

    // Logs require Cloud Logging API — return placeholder guidance
    const stdout = finalStatus === 'success'
      ? '(Logs available in Google Cloud Logging: resource.type="cloud_run_job")'
      : '';

    const durationMs = Date.now() - start;

    // Cleanup
    await crRequest('DELETE', `/${parent}/jobs/${jobId}`, token).catch(() => {});

    return {
      executionId,
      status: finalStatus,
      stdout,
      stderr: '',
      output: undefined,
      error: finalStatus !== 'success' ? `Job ${finalStatus}` : undefined,
      artifacts: [],
      durationMs,
      providerInfo: { provider: 'cloudrun', containerId: jobId, location: region, runtimeClass: 'gvisor' },
    };
  }

  async createSession(_chatId: string, _config: CSEConfig, _withBrowser: boolean): Promise<CSESession> {
    throw new Error('Cloud Run Jobs provider does not support persistent sessions. Use local or gke-gvisor instead.');
  }

  async executeInSession(): Promise<ExecutionResult> {
    throw new Error('Cloud Run Jobs provider does not support sessions.');
  }

  async terminateSession(): Promise<void> {}

  async healthCheck(config: CSEConfig): Promise<CSEHealthStatus> {
    try {
      await getGoogleToken(config);
      const region = config.cloudRunRegion ?? process.env['CLOUDRUN_REGION'] ?? 'us-central1';
      return {
        provider: 'cloudrun',
        healthy: true,
        details: { region, runtimeClass: 'gvisor (built-in)' },
      };
    } catch (err) {
      return { provider: 'cloudrun', healthy: false, error: String(err) };
    }
  }
}
