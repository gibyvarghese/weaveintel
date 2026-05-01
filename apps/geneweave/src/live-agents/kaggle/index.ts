/**
 * Phase K5 — Kaggle live-agents module barrel.
 *
 * Provides mesh templating, attention policies, account-binding capability
 * matrix, cross-mesh bridge wiring, and a single `bootKaggleMesh` entry point
 * that provisions the entire topology against any `StateStore`.
 *
 * See `docs/live-agents/kaggle.md` for the topology diagram and capability
 * matrix.
 */

export {
  buildKaggleMeshTemplate,
  type KaggleMeshTemplate,
  type KaggleMeshTemplateOptions,
} from './mesh-template.js';
export {
  KAGGLE_CAPABILITY_MATRIX,
  bindingConstraintsFor,
  type KaggleAgentRole,
} from './account-bindings.js';
export {
  buildKaggleBridge,
  KAGGLE_BRIDGE_TOPICS,
  type KaggleBridgeOptions,
} from './bridge.js';
export {
  createKaggleAttentionPolicy,
  type KaggleAttentionPolicyOptions,
} from './agents.js';
export {
  bootKaggleMesh,
  revokeKaggleBinding,
  type BootKaggleMeshOptions,
  type KaggleMeshBootResult,
} from './boot.js';
export { getKaggleLiveStore, _resetKaggleLiveStoreForTests } from './store.js';
export {
  KAGGLE_PLAYBOOK_CATEGORY,
  KAGGLE_PLAYBOOK_DEFAULT_PATTERN,
  createDbKagglePlaybookResolver,
  extractCompetitionSlugFromText,
  type KagglePlaybook,
  type KagglePlaybookConfig,
  type KagglePlaybookResolver,
  type PlaybookResolveOptions,
} from './playbook-resolver.js';
// Note: seedKaggleDemoMesh is intentionally NOT re-exported here because it
// imports the geneweave DatabaseAdapter type, which would pull the entire
// app DB layer into any consumer of this barrel (e.g. examples). Import it
// directly from './seed.js' from server boot only.
