/**
 * @weaveintel/core — Secret resolution
 *
 * Phase 2 of enterprise hardening. Two implementations:
 *   - `envSecretResolver({ prefix? })`      reads from `process.env`
 *   - `inMemorySecretResolver(map)`         seeds an in-memory map (tests, demos)
 *   - `chainSecretResolvers(...resolvers)`  first match wins
 *
 * Every adopter — including `apps/geneweave` and downstream apps — gets its
 * secrets through `runtime.secrets` rather than reading `process.env` ad-hoc.
 * That lets vault / cloud KMS / per-tenant overrides plug in later without
 * code changes at call sites.
 */

import type { SecretResolver } from './security.js';

export interface EnvSecretResolverOptions {
  /** Optional prefix to require on env var names (e.g. `WEAVE_`). */
  readonly prefix?: string;
  /** Custom env source. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Throw rather than resolve `undefined` for unknown keys. Default false. */
  readonly strict?: boolean;
}

export function envSecretResolver(opts: EnvSecretResolverOptions = {}): SecretResolver {
  const env = opts.env ?? (typeof process !== 'undefined' ? process.env : {});
  const prefix = opts.prefix ?? '';
  return {
    async resolve(key: string): Promise<string | undefined> {
      const lookup = prefix ? `${prefix}${key}` : key;
      const v = env[lookup];
      if (v == null && opts.strict) {
        throw new Error(`envSecretResolver: missing required secret '${lookup}'`);
      }
      return v;
    },
  };
}

export function inMemorySecretResolver(
  initial: Readonly<Record<string, string>> = {},
): SecretResolver & { set(key: string, value: string): void; delete(key: string): void } {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    async resolve(key: string): Promise<string | undefined> {
      return map.get(key);
    },
    set(key: string, value: string): void {
      map.set(key, value);
    },
    delete(key: string): void {
      map.delete(key);
    },
  };
}

export function chainSecretResolvers(...resolvers: SecretResolver[]): SecretResolver {
  if (resolvers.length === 0) {
    return { async resolve() { return undefined; } };
  }
  return {
    async resolve(key: string): Promise<string | undefined> {
      for (const r of resolvers) {
        const v = await r.resolve(key);
        if (v != null) return v;
      }
      return undefined;
    },
  };
}

/**
 * Convenience: throw a single clear error if a required secret is missing.
 * Use at server boot to fail fast instead of receiving cryptic 401s later.
 */
export async function requireSecret(resolver: SecretResolver, key: string): Promise<string> {
  const v = await resolver.resolve(key);
  if (v == null || v === '') {
    throw new Error(`required secret '${key}' is not available from the configured SecretResolver`);
  }
  return v;
}
