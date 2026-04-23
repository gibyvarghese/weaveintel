/**
 * @weaveintel/identity — Secret scope management
 *
 * Resolves access tokens scoped to identities and
 * environments. In-memory implementation for development.
 */

import type { SecretScope, AccessTokenResolver, RuntimeIdentity } from '@weaveintel/core';

type MutableInMemoryResolver = AccessTokenResolver & {
  __setToken?: (scope: SecretScope, identity: RuntimeIdentity, token: string) => void;
};

/** In-memory access token resolver for development / testing. */
export function weaveInMemoryTokenResolver(): AccessTokenResolver {
  const store = new Map<string, string>();

  function key(scope: SecretScope, identity: RuntimeIdentity): string {
    return `${scope.id}:${identity.id}`;
  }

  const resolver: MutableInMemoryResolver = {
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
    __setToken(scope: SecretScope, identity: RuntimeIdentity, token: string): void {
      store.set(key(scope, identity), token);
    },
  };

  return resolver;
}

/** Set a token in the in-memory resolver (for testing / bootstrapping). */
export function setToken(
  resolver: ReturnType<typeof weaveInMemoryTokenResolver>,
  scope: SecretScope,
  identity: RuntimeIdentity,
  token: string,
): void {
  const mutable = resolver as MutableInMemoryResolver;
  if (!mutable.__setToken) {
    throw new Error('Resolver does not support setToken helper');
  }
  mutable.__setToken(scope, identity, token);
}
