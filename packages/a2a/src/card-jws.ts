/**
 * @weaveintel/a2a — Agent card signatures in the A2A wire form, verified against a JWKS.
 *
 * Wire form (A2A v0.3 and v1.0 `AgentCardSignature`):
 *   { "protected": base64url(JSON protected header), "signature": base64url(signature), "header"?: {...} }
 *
 * The signature is a JWS (RFC 7515) with a DETACHED payload: the payload is the RFC 8785 (JCS) canonical JSON
 * of the card without its `signatures` member, so any reader that canonicalises the card it received can check
 * it, whatever order the members arrived in. The protected header is
 *   { "alg": "ES256", "typ": "JOSE", "kid": <key id>, "jku"?: <JWKS URL> }.
 *
 * Verification uses ONLY the JWKS the caller passes. It never fetches the `jku` the card names (an attacker who
 * can edit the card can also edit the `jku`); a caller that wants to check the `jku` passes `allowedJku`.
 * A card verifies when at least one of its signatures verifies with a key from that JWKS. Tampering with any
 * member of the card changes the canonical payload and fails every signature.
 *
 * A signature proves who published the card, not that the agent is trustworthy.
 *
 * The older `signAgentCard` / `verifyAgentCard` (`card-signer.ts`) write `{ algorithm, keyId, signature }` with
 * an attached, non-canonical payload; that is not the A2A wire form, and this verifier does not count it.
 */

/** One signature in the A2A wire form. */
export interface AgentCardJwsSignature {
  readonly protected: string;
  readonly signature: string;
  readonly header?: Readonly<Record<string, unknown>>;
}

/** A public ES256 key as published in a JWKS. */
export interface CardSigningJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
  readonly kid: string;
  readonly alg: 'ES256';
  readonly use: 'sig';
}

/** A JSON Web Key Set (RFC 7517) of card signing keys, as served at the JWKS URL. */
export interface CardJwks {
  readonly keys: readonly CardSigningJwk[];
}

export type CardJwsFailure =
  | 'unsigned'
  | 'malformed'
  | 'unsupported-alg'
  | 'unknown-key'
  | 'jku-not-trusted'
  | 'bad-signature';

export type CardJwsVerification =
  | { readonly valid: true; readonly kid: string }
  | { readonly valid: false; readonly reason: CardJwsFailure; readonly kid?: string };

export interface SignCardJwsOptions {
  /** The key id published in the JWKS. */
  readonly kid: string;
  /** The JWKS URL, written into the protected header. */
  readonly jku?: string;
}

export interface VerifyCardJwsOptions {
  /** The trusted JWKS (fetched by the caller from a place it trusts, e.g. its own tenant host). */
  readonly jwks: CardJwks;
  /** When given, a signature whose header names a `jku` must name one of these. */
  readonly allowedJku?: readonly string[];
}

// ─── Canonical JSON (RFC 8785) ───────────────────────────────────────────────

/**
 * RFC 8785 JSON Canonicalization Scheme for the JSON data model: object members sorted by UTF-16 code units,
 * no whitespace, ECMAScript number and string serialisation. `undefined` object members are omitted (as
 * `JSON.stringify` does). Throws on values JSON cannot carry (NaN, Infinity, functions, bigint, symbols).
 */
export function canonicalizeJson(value: unknown): string {
  return canon(value, 'value');
}

function canon(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value))
        throw new Error(`canonicalizeJson: ${path} is not a finite number`);
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => (v === undefined ? 'null' : canon(v, `${path}[${i}]`))).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      if (typeof (obj as { toJSON?: unknown }).toJSON === 'function') {
        return canon((obj as { toJSON: () => unknown }).toJSON(), path);
      }
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(obj[k], `${path}.${k}`)}`).join(',')}}`;
    }
    default:
      throw new Error(`canonicalizeJson: ${path} (${typeof value}) cannot be represented in JSON`);
  }
}

// ─── base64url ───────────────────────────────────────────────────────────────

function b64uEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(
      s
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(s.length + ((4 - (s.length % 4)) % 4), '='),
    );
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const utf8 = new TextEncoder();

function cardPayload(card: object): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { signatures: _omit, ...body } = card as { signatures?: unknown };
  return utf8.encode(canonicalizeJson(body));
}

function isP256Ecdsa(key: CryptoKey): boolean {
  const alg = key.algorithm as { name?: string; namedCurve?: string };
  return alg.name === 'ECDSA' && alg.namedCurve === 'P-256';
}

// ─── Sign ────────────────────────────────────────────────────────────────────

/**
 * Sign `card` with an ES256 (ECDSA P-256) private key and return a copy whose `signatures` has this signature
 * appended (signatures already present are kept and are not covered by the new one).
 */
export async function signAgentCardJws<C extends object>(
  card: C,
  privateKey: CryptoKey,
  opts: SignCardJwsOptions,
): Promise<Omit<C, 'signatures'> & { readonly signatures: readonly AgentCardJwsSignature[] }> {
  if (typeof opts.kid !== 'string' || opts.kid.trim() === '')
    throw new Error('signAgentCardJws: kid is required');
  if (!isP256Ecdsa(privateKey) || privateKey.type !== 'private') {
    throw new Error('signAgentCardJws: the key must be an ECDSA P-256 private key (ES256)');
  }
  const header: Record<string, string> = { alg: 'ES256', typ: 'JOSE', kid: opts.kid };
  if (opts.jku !== undefined) header['jku'] = opts.jku;
  const protectedB64 = b64uEncode(utf8.encode(JSON.stringify(header)));
  const signingInput = utf8.encode(`${protectedB64}.${b64uEncode(cardPayload(card))}`);
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      privateKey,
      signingInput as unknown as ArrayBuffer,
    ),
  );
  const existing = (card as { signatures?: unknown }).signatures;
  const prior = Array.isArray(existing) ? (existing as AgentCardJwsSignature[]) : [];
  return {
    ...card,
    signatures: [...prior, { protected: protectedB64, signature: b64uEncode(sig) }],
  };
}

// ─── JWKS ────────────────────────────────────────────────────────────────────

const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];

/** Export the public half of a card signing key as a JWK for the JWKS. Refuses a private key. */
export async function exportCardSigningJwk(
  publicKey: CryptoKey,
  kid: string,
): Promise<CardSigningJwk> {
  if (publicKey.type !== 'public')
    throw new Error('exportCardSigningJwk: only a public key may be published');
  if (!isP256Ecdsa(publicKey))
    throw new Error('exportCardSigningJwk: the key must be ECDSA P-256 (ES256)');
  if (typeof kid !== 'string' || kid.trim() === '')
    throw new Error('exportCardSigningJwk: kid is required');
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string')
    throw new Error('exportCardSigningJwk: export gave no coordinates');
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid, alg: 'ES256', use: 'sig' };
}

/**
 * Build the JWKS to publish. Refuses an entry that carries a private member, an entry that is not an ES256
 * P-256 key, and two entries with the same `kid`. Each entry is reduced to its public members.
 */
export function buildCardJwks(keys: readonly CardSigningJwk[]): CardJwks {
  const seen = new Set<string>();
  const out: CardSigningJwk[] = [];
  for (const k of keys) {
    const raw = k as unknown as Record<string, unknown>;
    if (PRIVATE_JWK_MEMBERS.some((m) => m in raw))
      throw new Error(`buildCardJwks: key "${String(raw['kid'])}" carries a private member`);
    if (
      raw['kty'] !== 'EC' ||
      raw['crv'] !== 'P-256' ||
      typeof raw['x'] !== 'string' ||
      typeof raw['y'] !== 'string'
    ) {
      throw new Error(`buildCardJwks: key "${String(raw['kid'])}" is not an EC P-256 public key`);
    }
    if (typeof raw['kid'] !== 'string' || raw['kid'] === '')
      throw new Error('buildCardJwks: every key needs a kid');
    if (seen.has(raw['kid'])) throw new Error(`buildCardJwks: duplicate kid "${raw['kid']}"`);
    seen.add(raw['kid']);
    out.push({
      kty: 'EC',
      crv: 'P-256',
      x: raw['x'],
      y: raw['y'],
      kid: raw['kid'],
      alg: 'ES256',
      use: 'sig',
    });
  }
  return { keys: out };
}

async function importJwk(jwks: CardJwks, kid: string): Promise<CryptoKey | null> {
  const entry = (jwks.keys ?? []).find((k) => (k as { kid?: unknown }).kid === kid) as
    | Record<string, unknown>
    | undefined;
  if (!entry) return null;
  if (
    entry['kty'] !== 'EC' ||
    entry['crv'] !== 'P-256' ||
    typeof entry['x'] !== 'string' ||
    typeof entry['y'] !== 'string'
  )
    return null;
  if (entry['alg'] !== undefined && entry['alg'] !== 'ES256') return null;
  if (entry['use'] !== undefined && entry['use'] !== 'sig') return null;
  try {
    // Only the public members are imported, whatever else the entry carries.
    return await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: entry['x'], y: entry['y'], ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  } catch {
    return null;
  }
}

// ─── Verify ──────────────────────────────────────────────────────────────────

type ParsedSig =
  | { ok: true; protectedB64: string; sig: Uint8Array; kid: string; jku?: string }
  | { ok: false; reason: CardJwsFailure; kid?: string };

/** Header members this verifier understands; anything listed in `crit` is refused (RFC 7515 §4.1.11). */
function parseSignature(entry: unknown): ParsedSig | null {
  if (entry === null || typeof entry !== 'object') return { ok: false, reason: 'malformed' };
  const e = entry as Record<string, unknown>;
  // The older `{ algorithm, keyId, signature }` form: not the wire form, not counted.
  if (!('protected' in e) && 'algorithm' in e && 'keyId' in e) return null;
  if (typeof e['protected'] !== 'string' || typeof e['signature'] !== 'string')
    return { ok: false, reason: 'malformed' };
  const headerBytes = b64uDecode(e['protected']);
  if (!headerBytes) return { ok: false, reason: 'malformed' };
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(headerBytes));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header))
    return { ok: false, reason: 'malformed' };
  const h = header as Record<string, unknown>;
  const kid = typeof h['kid'] === 'string' ? h['kid'] : undefined;
  if (h['alg'] !== 'ES256')
    return { ok: false, reason: 'unsupported-alg', ...(kid ? { kid } : {}) };
  if ('crit' in h) return { ok: false, reason: 'malformed', ...(kid ? { kid } : {}) };
  if (!kid) return { ok: false, reason: 'malformed' };
  if (h['jku'] !== undefined && typeof h['jku'] !== 'string')
    return { ok: false, reason: 'malformed', kid };
  const sig = b64uDecode(e['signature']);
  if (!sig || sig.length !== 64) return { ok: false, reason: 'malformed', kid };
  return {
    ok: true,
    protectedB64: e['protected'],
    sig,
    kid,
    ...(typeof h['jku'] === 'string' ? { jku: h['jku'] } : {}),
  };
}

/**
 * Verify `card` against the JWKS. Valid when at least one signature in the A2A wire form verifies with a key
 * from `opts.jwks`; otherwise the first failure is reported (`unsigned` when there is no wire-form signature).
 */
export async function verifyAgentCardJws(
  card: unknown,
  opts: VerifyCardJwsOptions,
): Promise<CardJwsVerification> {
  if (card === null || typeof card !== 'object' || Array.isArray(card))
    return { valid: false, reason: 'malformed' };
  const sigs = (card as { signatures?: unknown }).signatures;
  if (!Array.isArray(sigs) || sigs.length === 0) return { valid: false, reason: 'unsigned' };

  let payloadB64: string;
  try {
    payloadB64 = b64uEncode(cardPayload(card));
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  let firstFailure: { reason: CardJwsFailure; kid?: string } | undefined;
  let counted = 0;
  for (const entry of sigs) {
    const parsed = parseSignature(entry);
    if (parsed === null) continue;
    counted++;
    if (!parsed.ok) {
      firstFailure ??= parsed.kid
        ? { reason: parsed.reason, kid: parsed.kid }
        : { reason: parsed.reason };
      continue;
    }
    if (
      opts.allowedJku !== undefined &&
      parsed.jku !== undefined &&
      !opts.allowedJku.includes(parsed.jku)
    ) {
      firstFailure ??= { reason: 'jku-not-trusted', kid: parsed.kid };
      continue;
    }
    const key = await importJwk(opts.jwks, parsed.kid);
    if (!key) {
      firstFailure ??= { reason: 'unknown-key', kid: parsed.kid };
      continue;
    }
    let ok = false;
    try {
      ok = await crypto.subtle.verify(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        key,
        parsed.sig as unknown as ArrayBuffer,
        utf8.encode(`${parsed.protectedB64}.${payloadB64}`) as unknown as ArrayBuffer,
      );
    } catch {
      ok = false;
    }
    if (ok) return { valid: true, kid: parsed.kid };
    firstFailure ??= { reason: 'bad-signature', kid: parsed.kid };
  }
  if (counted === 0) return { valid: false, reason: 'unsigned' };
  return { valid: false, ...(firstFailure ?? { reason: 'bad-signature' }) };
}
