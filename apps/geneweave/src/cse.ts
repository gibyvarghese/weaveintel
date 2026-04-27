/**
 * @weaveintel/geneweave — Compute Sandbox Engine integration
 *
 * Lazy singleton that initialises the CSE from environment variables.
 * All CSE routes in server.ts use `getCSE()` to access the engine.
 */

import { ComputeSandboxEngine, buildCSEConfig } from '@weaveintel/sandbox';

let engine: ComputeSandboxEngine | null = null;
let initPromise: Promise<ComputeSandboxEngine> | null = null;

/** Returns true when CSE is available (local Docker is always available as fallback). */
export function isCSEEnabled(): boolean {
  const env = process.env;
  // If explicitly disabled, respect that.
  if (env['CSE_ENABLED'] === 'false') return false;
  // Local Docker is always the fallback — no env vars required.
  return true;
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
  }).catch((err: unknown) => {
    initPromise = null;
    throw err;
  });

  return initPromise;
}

/** Shut down the engine (call on process exit). */
export async function shutdownCSE(): Promise<void> {
  if (engine) await engine.shutdown();
  engine = null;
  initPromise = null;
}
