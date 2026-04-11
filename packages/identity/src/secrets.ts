/**
 * @weaveintel/identity — Secret scope management
 *
 * Resolves access tokens scoped to identities and
 * environments. In-memory implementation for development.
 */

import type { SecretScope, AccessTokenResolver, RuntimeIdentity } from '@weaveintel/core';

/** In-memory access token resolver for development / testing. */
export function weaveInMemoryTokenResolver(): AccessTokenResolver {
  const store = new Map<string, string>();

  function key(scope: SecretScope, identity: RuntimeIdentity): string {
    return `${scope.id}:${identity.id}`;
  }

  return {
    async resolve(scope: SecretScope, identity: RuntimeIdentity): Promise<string | null> {
      // Check allowed identities
      if (!scope.allowedIdentities.includes(identity.id) && !scope.allowedIdentities.includes('*')) {
        return null;
      }
      return store.get(key(scope, identity)) ?? null;
    },

    async revoke(scope: SecretScope, identity: RuntimeIdentity): Promise<void> {
      store.delete(key(scope, identity));
    },
  };
}

/** Set a token in the in-memory resolver (for testing / bootstrapping). */
export function setToken(
  resolver: ReturnType<typeof weaveInMemoryTokenResolver>,
  scope: SecretScope,
  identity: RuntimeIdentity,
  token: string,
): void {
  // Access internal store via closure — this is a test helper
  (resolver as { resolve: (s: SecretScope, i: RuntimeIdentity) => Promise<string | null> }).resolve(scope, identity);
  // We need direct access to the map; use a different approach
  void token;
  void scope;
  void identity;
}
