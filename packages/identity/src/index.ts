// SPDX-License-Identifier: MIT
/**
 * @weaveintel/identity — Public API
 */

export {
  createIdentity,
  createIdentityContext,
  createBootstrapIdentityContext,
  systemIdentity,
  agentIdentity,
} from './context.js';
export type { IdentityOptions } from './context.js';

export {
  createDelegation,
  isDelegationExpired,
  isDelegationAuthorised,
  validateDelegationChain,
  assertDelegationValid,
} from './delegation.js';

export {
  evaluateAccess,
  evaluateAccessBatch,
} from './access.js';
export type { AccessRule } from './access.js';

export {
  DEFAULT_RBAC_POLICY,
  resolvePersonaPermissions,
  hasPersonaPermission,
  extendIdentityWithPersona,
} from './rbac.js';
export type {
  RbacRoleDefinition,
  RbacPersonaDefinition,
  RbacPolicy,
} from './rbac.js';

export { weaveInMemoryTokenResolver } from './secrets.js';

// Domain error classes (L-27+A-6)
export { DelegationExpiredError } from './errors.js';

export { createSurfaceCatalogResolver } from './surface-catalog-resolver.js';
export type { CatalogSource, AccessCheck, CatalogCache, SurfaceCatalogResolverOptions } from './surface-catalog-resolver.js';
