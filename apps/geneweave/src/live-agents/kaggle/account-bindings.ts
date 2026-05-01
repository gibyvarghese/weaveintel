/**
 * Phase K5 — Kaggle live-agents account-binding capability matrix.
 *
 * Per design §5.3, every live-agent in the kaggle mesh binds to a single
 * Kaggle credential Account. The capabilities array on the AccountBinding row
 * is the platform's authoritative gate (separate from tool policies, defense in
 * depth). Revoking a single capability immediately stops that agent's next
 * tick — no redeploy.
 */

export type KaggleAgentRole =
  | 'discoverer'
  | 'strategist'
  | 'implementer'
  | 'validator'
  | 'submitter'
  | 'observer';

export const KAGGLE_CAPABILITY_MATRIX: Record<KaggleAgentRole, readonly string[]> = {
  discoverer:  ['KAGGLE_LIST_COMPETITIONS', 'KAGGLE_READ_DATASETS'],
  strategist:  ['KAGGLE_LIST_KERNELS', 'KAGGLE_READ_KERNELS'],
  implementer: ['KAGGLE_PUSH_KERNEL', 'KAGGLE_READ_KERNELS'],
  validator:   ['KAGGLE_DOWNLOAD_DATA', 'KAGGLE_LOCAL_COMPUTE'],
  submitter:   ['KAGGLE_SUBMIT'],
  observer:    ['KAGGLE_READ_LEADERBOARD', 'KAGGLE_READ_SUBMISSIONS'],
};

/** Capability constraint string baked into the AccountBinding.constraints field. */
export function bindingConstraintsFor(role: KaggleAgentRole): string {
  const caps = KAGGLE_CAPABILITY_MATRIX[role];
  return `Capabilities: ${caps.join(', ')}. Capability revocation takes effect on next tick.`;
}
