/**
 * @weaveintel/sandbox/cse — Provider registry + auto-detection
 *
 * Loads the correct ContainerProvider based on:
 *   1. Explicit CSE_PROVIDER env var  (or config.provider)
 *   2. Auto-detection from present env vars
 *
 * Auto-detection priority:
 *   aks-kata     →  AKS_CLUSTER_NAME or (KUBECONFIG present + AZURE_TENANT_ID)
 *   gke-gvisor   →  GKE_CLUSTER or (KUBECONFIG present + GKE_PROJECT_ID)
 *   aci          →  AZURE_SUBSCRIPTION_ID (without k8s vars)
 *   cloudrun     →  CLOUDRUN_PROJECT_ID or GOOGLE_APPLICATION_CREDENTIALS (without k8s vars)
 *   local        →  fallback (Docker required)
 */

import type { ContainerProvider } from './providers/base.js';
import { LocalDockerProvider } from './providers/local.js';
import { AKSKataProvider } from './providers/aks.js';
import { GKEGVisorProvider } from './providers/gke.js';
import { ACIProvider } from './providers/aci.js';
import { CloudRunJobsProvider } from './providers/cloudrun.js';
import type { CSEConfig, CSEProviderKind } from './types.js';

function detectProvider(): CSEProviderKind {
  const env = process.env;

  // Explicit override
  const explicit = env['CSE_PROVIDER'] as CSEProviderKind | undefined;
  if (explicit) return explicit;

  // AKS: cluster name in env OR kubeconfig + Azure creds
  if (env['AKS_CLUSTER_NAME'] || (env['KUBECONFIG'] && env['AZURE_TENANT_ID'])) {
    return 'aks-kata';
  }

  // GKE: cluster name in env OR kubeconfig + Google project
  if (env['GKE_CLUSTER'] || (env['KUBECONFIG'] && env['GKE_PROJECT_ID'])) {
    return 'gke-gvisor';
  }

  // ACI: Azure subscription without k8s pointers
  if (env['AZURE_SUBSCRIPTION_ID'] && !env['KUBECONFIG']) {
    return 'aci';
  }

  // Cloud Run: Google project or credentials without k8s
  if ((env['CLOUDRUN_PROJECT_ID'] || env['GOOGLE_APPLICATION_CREDENTIALS']) && !env['KUBECONFIG']) {
    return 'cloudrun';
  }

  // Default: local Docker
  return 'local';
}

export function buildCSEConfig(): CSEConfig {
  const env = process.env;
  return {
    provider: (env['CSE_PROVIDER'] as CSEProviderKind | undefined) ?? detectProvider(),
    executionImage: env['CSE_EXECUTION_IMAGE'],
    browserImage: env['CSE_BROWSER_IMAGE'],
    timeoutMs: env['CSE_TIMEOUT_MS'] ? parseInt(env['CSE_TIMEOUT_MS'], 10) : undefined,
    memoryMb: env['CSE_MEMORY_MB'] ? parseInt(env['CSE_MEMORY_MB'], 10) : undefined,
    cpuCount: env['CSE_CPU_COUNT'] ? parseFloat(env['CSE_CPU_COUNT']) : undefined,
    networkAccess: env['CSE_NETWORK_ACCESS'] === 'true',
    kubeconfig: env['CSE_KUBECONFIG'] ?? env['KUBECONFIG'],
    namespace: env['CSE_NAMESPACE'],
    runtimeClass: env['CSE_RUNTIME_CLASS'],
    serviceAccount: env['CSE_SERVICE_ACCOUNT'],

    // AKS
    aksSubscriptionId: env['AKS_SUBSCRIPTION_ID'] ?? env['AZURE_SUBSCRIPTION_ID'],
    aksResourceGroup: env['AKS_RESOURCE_GROUP'] ?? env['AZURE_RESOURCE_GROUP'],
    aksClusterName: env['AKS_CLUSTER_NAME'],

    // GKE
    gkeProjectId: env['GKE_PROJECT_ID'] ?? env['GOOGLE_PROJECT_ID'],
    gkeCluster: env['GKE_CLUSTER'],
    gkeRegion: env['GKE_REGION'] ?? env['GKE_ZONE'],

    // Azure shared
    azureClientId: env['AZURE_CLIENT_ID'],
    azureClientSecret: env['AZURE_CLIENT_SECRET'],
    azureTenantId: env['AZURE_TENANT_ID'],
    azureSubscriptionId: env['AZURE_SUBSCRIPTION_ID'],

    // ACI
    aciResourceGroup: env['ACI_RESOURCE_GROUP'] ?? env['AZURE_RESOURCE_GROUP'],
    aciLocation: env['ACI_LOCATION'],

    // Google shared
    googleProjectId: env['GOOGLE_PROJECT_ID'] ?? env['CLOUDRUN_PROJECT_ID'] ?? env['GKE_PROJECT_ID'],
    googleCredentials: env['GOOGLE_CREDENTIALS_JSON'],

    // Cloud Run
    cloudRunRegion: env['CLOUDRUN_REGION'],

    // Session
    sessionTtlMs: env['CSE_SESSION_TTL_MS'] ? parseInt(env['CSE_SESSION_TTL_MS'], 10) : undefined,
    maxSessions: env['CSE_MAX_SESSIONS'] ? parseInt(env['CSE_MAX_SESSIONS'], 10) : undefined,
  };
}

export function createProvider(kind: CSEProviderKind): ContainerProvider {
  switch (kind) {
    case 'local':      return new LocalDockerProvider();
    case 'aks-kata':   return new AKSKataProvider();
    case 'gke-gvisor': return new GKEGVisorProvider();
    case 'aci':        return new ACIProvider();
    case 'cloudrun':   return new CloudRunJobsProvider();
    default:           throw new Error(`Unknown CSE provider: ${kind as string}`);
  }
}
