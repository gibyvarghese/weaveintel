/**
 * @weaveintel/identity — Public API
 */

export {
  createIdentity,
  createIdentityContext,
  systemIdentity,
  agentIdentity,
} from './context.js';
export type { IdentityOptions } from './context.js';

export {
  createDelegation,
  isDelegationExpired,
  isDelegationAuthorised,
  validateDelegationChain,
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
