/**
 * The access-token cache: in memory only, keyed by the caller (workspace, credential, generation, subject, scope
 * set), ONE fetch at a time per key (single flight), and a token is reused until 80 % of its stated life has passed
 * (FRAMEWORK 2.3). Refresh tokens are not kept here: they are secrets, and the host seals them.
 *
 * Single flight is per process. A host that runs several processes adds its own lock around `fetch` (FRAMEWORK 2.3:
 * "across processes through a host lock").
 */

/** What a token fetch returns. */
export interface FetchedToken {
  readonly token: string
  /** Seconds the token is valid for, as the issuer said. Absent: treated as 300. */
  readonly expiresInSeconds?: number | undefined
}

/** The cache. */
export interface TokenCache {
  /**
   * The current token for a key, fetching one (once, whoever else is waiting) when none is fresh.
   * @throws whatever `obtain` throws; every waiter receives the same failure, and nothing is cached.
   */
  get(key: string, obtain: () => Promise<FetchedToken>, now: () => number): Promise<string>
  /** Forget a key (the credential was replaced or revoked, or the token was refused). */
  drop(key: string): void
}

/** Build an empty cache. */
export function createTokenCache(): TokenCache {
  const fresh = new Map<string, { readonly token: string; readonly until: number }>()
  const inFlight = new Map<string, Promise<string>>()
  return {
    async get(key, obtain, now) {
      const hit = fresh.get(key)
      if (hit !== undefined && hit.until > now()) return hit.token
      const waiting = inFlight.get(key)
      if (waiting !== undefined) return waiting
      const started = now()
      const p = (async () => {
        try {
          const t = await obtain()
          const life = (t.expiresInSeconds !== undefined && Number.isFinite(t.expiresInSeconds) && t.expiresInSeconds > 0 ? t.expiresInSeconds : 300) * 1000
          fresh.set(key, { token: t.token, until: started + Math.floor(life * 0.8) })
          return t.token
        } finally {
          inFlight.delete(key)
        }
      })()
      inFlight.set(key, p)
      return p
    },
    drop(key) {
      fresh.delete(key)
    },
  }
}
