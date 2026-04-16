/**
 * @weaveintel/sandbox/cse — AKS + Kata Containers provider
 *
 * Runs code in Azure Kubernetes Service nodes with the Kata Containers
 * runtime (kata-mshv-vm-isolation). Each workload runs in a hardware-
 * isolated micro-VM — kernel, memory and CPU are not shared with the host.
 *
 * Required AKS setup:
 *   1. AKS node pool with --workload-runtime KataMshvVmIsolation
 *   2. RuntimeClass 'kata-mshv-vm-isolation' auto-created by AKS
 *
 * Required env vars:
 *   AKS_SUBSCRIPTION_ID, AKS_RESOURCE_GROUP, AKS_CLUSTER_NAME,
 *   AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID   (for kubeconfig fetch)
 *   or: set a valid KUBECONFIG / CSE_KUBECONFIG pointing at the AKS cluster.
 *
 * Optional: CSE_NAMESPACE (default: cse), CSE_RUNTIME_CLASS override.
 */

import { K8sContainerProvider } from './k8s.js';
import type { CSEConfig, CSEHealthStatus } from '../types.js';

export class AKSKataProvider extends K8sContainerProvider {
  readonly kind = 'aks-kata' as const;
  /**
   * Default RuntimeClass name on AKS for Kata Containers (confidential VMs).
   * AKS also supports 'kata-cc' (confidential containers with attestation).
   */
  readonly runtimeClassName = 'kata-mshv-vm-isolation';

  override async initialize(config: CSEConfig): Promise<void> {
    // If AKS cluster details are provided, we could fetch the kubeconfig
    // automatically via the Azure REST API. For now, trust the kubeconfig.
    await super.initialize(config);
  }

  override async healthCheck(config: CSEConfig): Promise<CSEHealthStatus> {
    const base = await super.healthCheck(config);
    if (!base.healthy) return base;

    // Verify the Kata RuntimeClass exists on this cluster
    try {
      const res = await (this.client as any).request(
        'GET',
        '/apis/node.k8s.io/v1/runtimeclasses/kata-mshv-vm-isolation',
      );
      if (!(res as any).ok) {
        return {
          provider: this.kind,
          healthy: false,
          error: 'RuntimeClass kata-mshv-vm-isolation not found. Enable Kata node pools on AKS.',
        };
      }
    } catch { /* API may not be reachable in all contexts */ }

    return { ...base, provider: this.kind };
  }
}
