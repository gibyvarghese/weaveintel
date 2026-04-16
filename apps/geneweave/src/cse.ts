/**
 * @weaveintel/geneweave — Compute Sandbox Engine integration
 *
 * Lazy singleton that initialises the CSE from environment variables.
 * All CSE routes in server.ts use `getCSE()` to access the engine.
 */

import { ComputeSandboxEngine, buildCSEConfig } from '@weaveintel/sandbox';

let engine: ComputeSandboxEngine | null = null;
let initPromise: Promise<ComputeSandboxEngine> | null = null;

/** Returns true when at least one CSE env var is set. */
export function isCSEEnabled(): boolean {
  const env = process.env;
  return !!(
    env['CSE_PROVIDER'] ||
    env['AKS_CLUSTER_NAME'] ||
    env['GKE_CLUSTER'] ||
    env['ACI_RESOURCE_GROUP'] ||
    env['CLOUDRUN_PROJECT_ID'] ||
    env['GOOGLE_APPLICATION_CREDENTIALS']
  );
}

/**
 * Get (or lazily initialise) the ComputeSandboxEngine.
 * Returns null if CSE is not configured.
 */
export async function getCSE(): Promise<ComputeSandboxEngine | null> {
  if (!isCSEEnabled()) return null;
  if (engine) return engine;
  if (initPromise) return initPromise;

  initPromise = ComputeSandboxEngine.create(buildCSEConfig()).then((e) => {
    engine = e;
    return e;
  });

  return initPromise;
}

/** Shut down the engine (call on process exit). */
export async function shutdownCSE(): Promise<void> {
  if (engine) await engine.shutdown();
  engine = null;
  initPromise = null;
}
