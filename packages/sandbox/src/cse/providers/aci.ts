/**
 * @weaveintel/sandbox/cse — Azure Container Instances (ACI) provider
 *
 * Runs code in Azure Container Instances — a serverless container service
 * that requires no Kubernetes cluster. Each execution spawns a new container
 * group, runs code, and is deleted after completion.
 *
 * ACI does NOT support Kata Containers in standard SKU. For strong isolation
 * use 'aks-kata'. ACI does apply hypervisor-level isolation between tenants
 * (different container groups run on separate VMs).
 *
 * Required env vars:
 *   AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP, AZURE_LOCATION,
 *   AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID
 *
 * Optional: CSE_EXECUTION_IMAGE, CSE_TIMEOUT_MS, CSE_MEMORY_MB
 */

import { randomUUID } from 'node:crypto';
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
const ACI_API_VERSION = '2023-05-01';
const ARM_BASE = 'https://management.azure.com';
const AZURE_AUTH_URL = 'https://login.microsoftonline.com';

// ─── Azure auth (client credentials flow) ────────────────────

interface AzureToken {
  access_token: string;
  expires_in: number;
  obtainedAt: number;
}

let cachedToken: AzureToken | null = null;

async function getAzureToken(config: CSEConfig): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.obtainedAt + (cachedToken.expires_in - 60) * 1_000) {
    return cachedToken.access_token;
  }

  const tenantId = config.azureTenantId ?? process.env['AZURE_TENANT_ID'];
  const clientId = config.azureClientId ?? process.env['AZURE_CLIENT_ID'];
  const clientSecret = config.azureClientSecret ?? process.env['AZURE_CLIENT_SECRET'];

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      'Azure credentials required: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET',
    );
  }

  const resp = await fetch(`${AZURE_AUTH_URL}/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://management.azure.com/.default',
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Azure auth failed: ${err}`);
  }

  const data = (await resp.json()) as { access_token: string; expires_in: number };
  cachedToken = { ...data, obtainedAt: now };
  return data.access_token;
}

async function aciRequest(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const resp = await fetch(`${ARM_BASE}${path}?api-version=${ACI_API_VERSION}`, {
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

export class ACIProvider implements ContainerProvider {
  readonly kind = 'aci' as const;
  /** ACI does not support long-lived session containers in a serverless model. */
  readonly supportsSession = false;
  readonly supportsBrowser = false;

  async initialize(config: CSEConfig): Promise<void> {
    // Validate credentials by fetching a token
    await getAzureToken(config);
  }

  async execute(request: ExecutionRequest, config: CSEConfig): Promise<ExecutionResult> {
    const executionId = randomUUID();
    const containerGroupName = `cse-${executionId.slice(0, 16)}`;

    const subscriptionId = config.azureSubscriptionId ?? process.env['AZURE_SUBSCRIPTION_ID'];
    const resourceGroup = config.aciResourceGroup ?? process.env['ACI_RESOURCE_GROUP'] ?? process.env['AZURE_RESOURCE_GROUP'];
    const location = config.aciLocation ?? process.env['ACI_LOCATION'] ?? 'eastus';
    const image = config.executionImage ?? DEFAULT_EXECUTION_IMAGE;
    const timeoutMs = request.timeoutMs ?? config.timeoutMs ?? 30_000;
    const memoryMb = config.memoryMb ?? 512;
    const cpuCount = config.cpuCount ?? 1;
    const lang = request.language ?? 'python';

    if (!subscriptionId) throw new Error('AZURE_SUBSCRIPTION_ID is required for ACI provider');
    if (!resourceGroup) throw new Error('ACI_RESOURCE_GROUP or AZURE_RESOURCE_GROUP is required');

    // Build startup command: inject code via base64, decode in container, run
    const codeB64 = Buffer.from(request.code).toString('base64');
    const ext = languageExt(lang);
    const runCmd = buildRunCommand(lang);
    const entrypoint = [
      'sh', '-c',
      `echo "${codeB64}" | base64 -d > /tmp/code.${ext} && ${runCmd.join(' ').replace(`/workspace/code.${ext}`, `/tmp/code.${ext}`)}`,
    ];

    const envVars = Object.entries(request.env ?? {})
      .filter(([k]) => /^[A-Z_][A-Z0-9_]*$/i.test(k))
      .map(([name, value]) => ({ name, value }));

    const token = await getAzureToken(config);
    const basePath = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ContainerInstance/containerGroups`;

    const containerGroup = {
      location,
      properties: {
        osType: 'Linux',
        restartPolicy: 'Never',
        containers: [
          {
            name: 'executor',
            properties: {
              image,
              command: entrypoint,
              environmentVariables: envVars,
              resources: {
                requests: {
                  cpu: cpuCount,
                  memoryInGB: memoryMb / 1024,
                },
              },
            },
          },
        ],
        // No public IP → isolated egress
        ...(!(request.networkAccess ?? config.networkAccess) ? {
          networkProfile: undefined,
          subnetIds: undefined,
        } : {}),
      },
    };

    const start = Date.now();
    const createRes = await aciRequest(
      'PUT',
      `${basePath}/${containerGroupName}`,
      token,
      containerGroup,
    );

    if (!createRes.ok) {
      return {
        executionId,
        status: 'error',
        stdout: '',
        stderr: JSON.stringify(createRes.data),
        error: `ACI container group creation failed: HTTP ${createRes.status}`,
        artifacts: [],
        durationMs: Date.now() - start,
        providerInfo: { provider: 'aci', location },
      };
    }

    // Poll until terminated
    const deadline = Date.now() + timeoutMs + 30_000;
    let stdout = '';
    let finalState = 'error';

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3_000));
      const getRes = await aciRequest('GET', `${basePath}/${containerGroupName}`, token);
      const cg = getRes.data as any;
      const state = cg?.properties?.containers?.[0]?.properties?.instanceView?.currentState?.state;

      if (state === 'Terminated') {
        const exitCode = cg.properties.containers[0].properties.instanceView.currentState.exitCode;
        finalState = exitCode === 0 ? 'success' : 'error';

        // Fetch logs
        const logsRes = await aciRequest(
          'POST',
          `${basePath}/${containerGroupName}/containers/executor/logs`,
          token,
        );
        stdout = (logsRes.data as any)?.content ?? '';
        break;
      }
    }

    const durationMs = Date.now() - start;

    // Cleanup
    await aciRequest('DELETE', `${basePath}/${containerGroupName}`, token).catch(() => {});

    const status = durationMs >= timeoutMs + 30_000 ? 'timeout' : (finalState as ExecutionResult['status']);

    return {
      executionId,
      status,
      stdout: stdout.slice(0, 100_000),
      stderr: '',
      output: status === 'success' ? tryParseOutput(stdout) : undefined,
      error: status !== 'success' ? `Container ${status}` : undefined,
      artifacts: [],
      durationMs,
      providerInfo: { provider: 'aci', containerId: containerGroupName, location },
    };
  }

  async createSession(_chatId: string, _config: CSEConfig, _withBrowser: boolean): Promise<CSESession> {
    throw new Error('ACI provider does not support persistent sessions. Use local or aks-kata instead.');
  }

  async executeInSession(): Promise<ExecutionResult> {
    throw new Error('ACI provider does not support sessions.');
  }

  async terminateSession(): Promise<void> {}

  async healthCheck(config: CSEConfig): Promise<CSEHealthStatus> {
    try {
      await getAzureToken(config);
      return { provider: 'aci', healthy: true, details: { region: config.aciLocation ?? 'eastus' } };
    } catch (err) {
      return { provider: 'aci', healthy: false, error: String(err) };
    }
  }
}
