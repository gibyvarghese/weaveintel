/**
 * @weaveintel/a2a — JWT Validator (Phase 5)
 *
 * Validates bearer JWTs on inbound A2A requests. Enforces:
 *   - `exp` (with clock-skew tolerance)
 *   - `nbf` (not-before)
 *   - `aud` must include the agent name or base URL
 *   - `scope` must include the skill ID being invoked
 *   - `jti` replay prevention via LRU cache (size configurable)
 *   - optional signature verification via public key callback
 *
 * The validator is passed into `createA2ADispatcher()` as an optional
 * callback. When present, every request with an Authorization: Bearer header
 * is validated before dispatch.
 *
 * If no Authorization header is present AND the validator is set, the request
 * is rejected with a 401 UNAUTHORIZED error. Callers that want to allow
 * unauthenticated requests should omit the validator.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface JwtPayload {
  readonly sub?: string;
  readonly iss?: string;
  readonly aud?: string | readonly string[];
  readonly exp?: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly jti?: string;
  readonly scope?: string;
  readonly [claim: string]: unknown;
}

export interface JwtValidatorOptions {
  /** Agent name or base URL — validated against `aud` claim. */
  readonly audience: string;
  /** Skill ID being invoked — must appear in `scope` claim. */
  readonly skillId?: string;
  /**
   * Maximum allowed clock skew in seconds (default: 60).
   * Applied symmetrically to both `exp` and `nbf` checks.
   */
  readonly clockSkewSeconds?: number;
  /** Callback to resolve a public key by `kid` for signature verification. */
  readonly getPublicKey?: (kid: string) => Promise<CryptoKey | null>;
  /** JTI replay-prevention cache. If absent, JTI is not checked. */
  readonly jtiCache?: JtiCache;
}

export interface JtiCache {
  has(jti: string): boolean;
  add(jti: string, expiresAt: number): void;
}

export type JwtValidatorFn = (
  authorizationHeader: string,
  opts: Pick<JwtValidatorOptions, 'skillId'>,
) => Promise<JwtPayload | null>;

// ─── LRU JTI cache ─────────────────────────────────────────────────────────────

/**
 * Create a bounded LRU cache for JTI replay prevention.
 * Entries expire at their token's `exp` time (stored in the cache entry).
 * Oldest entries are evicted once `maxSize` is reached.
 */
export function createJtiCache(maxSize = 10_000): JtiCache {
  // Map preserves insertion order; we rely on that for LRU eviction.
  const store = new Map<string, number>(); // jti → expiresAt (unix seconds)

  return {
    has(jti) {
      const exp = store.get(jti);
      if (exp === undefined) return false;
      // Expired entries don't count as replays (token would fail exp check anyway)
      if (Date.now() / 1000 > exp) {
        store.delete(jti);
        return false;
      }
      return true;
    },
    add(jti, expiresAt) {
      if (store.has(jti)) return;
      if (store.size >= maxSize) {
        // Evict the oldest entry
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      store.set(jti, expiresAt);
    },
  };
}

// ─── JWT parsing (no external dep) ───────────────────────────────────────────

function base64urlDecode(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    s.length + ((4 - (s.length % 4)) % 4),
    '=',
  );
  return atob(padded);
}

function parseJwtParts(token: string): {
  headerB64: string;
  payloadB64: string;
  sigB64: string;
  header: Record<string, unknown>;
  payload: JwtPayload;
} | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [p0, p1, p2] = [parts[0]!, parts[1]!, parts[2]!];
  try {
    const header = JSON.parse(base64urlDecode(p0)) as Record<string, unknown>;
    const payload = JSON.parse(base64urlDecode(p1)) as JwtPayload;
    return { headerB64: p0, payloadB64: p1, sigB64: p2, header, payload };
  } catch {
    return null;
  }
}

// ─── Claim validation ─────────────────────────────────────────────────────────

function audMatches(aud: string | readonly string[] | undefined, expected: string): boolean {
  if (!aud) return false;
  const list = Array.isArray(aud) ? aud : [aud];
  return list.some((a) => a === expected);
}

function scopeContains(scope: string | undefined, skillId: string): boolean {
  if (!scope) return false;
  return scope.split(/\s+/).includes(skillId);
}

// ─── Signature verification ───────────────────────────────────────────────────

async function verifyJwtSignature(
  token: string,
  header: Record<string, unknown>,
  getPublicKey: (kid: string) => Promise<CryptoKey | null>,
): Promise<boolean> {
  const alg = header['alg'];
  const kid = typeof header['kid'] === 'string' ? header['kid'] : '';

  if (alg !== 'ES256' && alg !== 'RS256') return false;

  const pubKey = await getPublicKey(kid);
  if (!pubKey) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const signingInput = new TextEncoder().encode(`${parts[0]!}.${parts[1]!}`);
  const rawSig = Uint8Array.from(atob(parts[2]!.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0),
  );

  const algorithm =
    alg === 'ES256'
      ? ({ name: 'ECDSA', hash: { name: 'SHA-256' } } as AlgorithmIdentifier)
      : ({ name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } } as AlgorithmIdentifier);

  try {
    return await crypto.subtle.verify(algorithm, pubKey, rawSig as unknown as ArrayBuffer, signingInput as unknown as ArrayBuffer);
  } catch {
    return false;
  }
}

// ─── Main validator ───────────────────────────────────────────────────────────

/**
 * Create a bound JWT validator for a specific agent.
 *
 * Returns a `JwtValidatorFn` that:
 *   1. Strips "Bearer " prefix
 *   2. Parses the JWT without verifying signature (HS256/unsigned not supported)
 *   3. Checks `exp`, `nbf`, `aud`, `scope`, `jti`
 *   4. Verifies signature if `getPublicKey` was provided
 *   5. Records `jti` in the replay-prevention cache on success
 *
 * Returns the decoded payload on success, null on any failure.
 */
export function createJwtValidator(opts: JwtValidatorOptions): JwtValidatorFn {
  const clockSkew = opts.clockSkewSeconds ?? 60;

  return async function validateBearerJwt(
    authorizationHeader: string,
    callOpts: Pick<JwtValidatorOptions, 'skillId'>,
  ): Promise<JwtPayload | null> {
    if (!authorizationHeader.startsWith('Bearer ')) return null;
    const token = authorizationHeader.slice(7).trim();

    const parsed = parseJwtParts(token);
    if (!parsed) return null;
    const { payload, header } = parsed;

    const now = Math.floor(Date.now() / 1000);

    // exp check
    if (payload.exp !== undefined && now > payload.exp + clockSkew) {
      return null; // expired
    }

    // nbf check
    if (payload.nbf !== undefined && now < payload.nbf - clockSkew) {
      return null; // not yet valid
    }

    // aud check
    if (!audMatches(payload.aud, opts.audience)) {
      return null;
    }

    // scope check (if a skill is being invoked)
    const skillId = callOpts.skillId ?? opts.skillId;
    if (skillId && !scopeContains(payload.scope, skillId)) {
      return null;
    }

    // jti replay check
    if (payload.jti !== undefined && opts.jtiCache) {
      if (opts.jtiCache.has(payload.jti)) {
        return null; // replayed token
      }
    }

    // Signature verification (optional)
    if (opts.getPublicKey) {
      const sigValid = await verifyJwtSignature(token, header, opts.getPublicKey);
      if (!sigValid) return null;
    }

    // Record JTI after all checks pass
    if (payload.jti !== undefined && opts.jtiCache) {
      opts.jtiCache.add(payload.jti, payload.exp ?? now + 3600);
    }

    return payload;
  };
}
