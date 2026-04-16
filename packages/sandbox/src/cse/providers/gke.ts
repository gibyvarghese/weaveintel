/**
 * @weaveintel/sandbox/cse — GKE + gVisor provider
 *
 * Runs code in Google Kubernetes Engine sandbox nodes using the gVisor
 * (runsc) runtime. gVisor intercepts every system call through a user-space
 * kernel — the container process never touches the host kernel directly.
 *
 * Required GKE setup:
 *   1. GKE node pool with --sandbox-type=gvisor
 *   2. RuntimeClass 'gvisor' is created automatically by GKE
 *
 * Required env vars:
 *   GKE_PROJECT_ID, GKE_CLUSTER, GKE_REGION (or GKE_ZONE)
 *   GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CREDENTIALS_JSON
 *   or: set a valid KUBECONFIG / CSE_KUBECONFIG pointing at the GKE cluster.
 *
 * Optional: CSE_NAMESPACE (default: cse), CSE_RUNTIME_CLASS override.
 */

import { K8sContainerProvider } from './k8s.js';
import type { CSEConfig, CSEHealthStatus } from '../types.js';

export class GKEGVisorProvider extends K8sContainerProvider {
  readonly kind = 'gke-gvisor' as const;
  /**
   * GKE automatically creates this RuntimeClass on sandbox node pools.
   * Cloud Run (managed) uses gVisor by default — no RuntimeClass needed there.
   */
  readonly runtimeClassName = 'gvisor';

  override async initialize(config: CSEConfig): Promise<void> {
    await super.initialize(config);
  }

  override async healthCheck(config: CSEConfig): Promise<CSEHealthStatus> {
    const base = await super.healthCheck(config);
    if (!base.healthy) return base;

    // Verify the gvisor RuntimeClass exists
    try {
      const res = await (this.client as any).request(
        'GET',
        '/apis/node.k8s.io/v1/runtimeclasses/gvisor',
      );
      if (!(res as any).ok) {
        return {
          provider: this.kind,
          healthy: false,
          error: 'RuntimeClass "gvisor" not found. Enable sandbox node pools on GKE (--sandbox-type=gvisor).',
        };
      }
    } catch { /* kubeconfig may restrict runtimeclass reads */ }

    return { ...base, provider: this.kind };
  }
}
