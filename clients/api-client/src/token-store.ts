/**
 * token-store.ts — pluggable, async credential storage + namespacing.
 *
 * The mobile app (M3) backs `TokenStore` with `expo-secure-store`; tests and
 * Node clients use {@link MemoryTokenStore}. The client reads the bearer token
 * and CSRF token through this on every request and persists a refreshed token
 * back into it.
 *
 * Per-tenant configurability: a single device may hold sessions for several
 * tenants/hosts. {@link namespacedTokenStore} prefixes a backing key/value
 * store so multiple independent clients can coexist without colliding — the
 * host picks the namespace (e.g. the tenant id or host origin).
 */

/** A bearer session: the JWT plus the CSRF token to send on mutations. */
export interface AuthTokens {
  token: string;
  csrfToken: string;
}

/** Async credential storage. All methods may be sync or async. */
export interface TokenStore {
  get(): Promise<AuthTokens | null>;
  set(value: AuthTokens): Promise<void>;
  clear(): Promise<void>;
}

/** Zero-dependency in-memory token store for tests and Node clients. */
export class MemoryTokenStore implements TokenStore {
  private _value: AuthTokens | null = null;
  constructor(initial: AuthTokens | null = null) {
    this._value = initial;
  }
  async get(): Promise<AuthTokens | null> {
    return this._value;
  }
  async set(value: AuthTokens): Promise<void> {
    this._value = value;
  }
  async clear(): Promise<void> {
    this._value = null;
  }
}

/**
 * A minimal async key/value store (e.g. `expo-secure-store`, `AsyncStorage`,
 * `localStorage`). Used by {@link namespacedTokenStore} to back a per-tenant
 * `TokenStore`.
 */
export interface KeyValueStore {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/**
 * Builds a `TokenStore` over a generic key/value store, scoped under a
 * namespace so multiple tenants/hosts can store sessions side-by-side on one
 * device. The stored value is JSON; a malformed entry resolves to `null`
 * (degrade to "logged out") rather than throwing.
 */
export function namespacedTokenStore(kv: KeyValueStore, namespace: string): TokenStore {
  const key = `@geneweave/auth:${namespace}`;
  return {
    async get(): Promise<AuthTokens | null> {
      const raw = await kv.getItem(key);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as Partial<AuthTokens>;
        if (typeof parsed.token === 'string' && typeof parsed.csrfToken === 'string') {
          return { token: parsed.token, csrfToken: parsed.csrfToken };
        }
        return null;
      } catch {
        return null;
      }
    },
    async set(value: AuthTokens): Promise<void> {
      await kv.setItem(key, JSON.stringify(value));
    },
    async clear(): Promise<void> {
      await kv.removeItem(key);
    },
  };
}
