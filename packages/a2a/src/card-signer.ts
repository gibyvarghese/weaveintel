/**
 * @weaveintel/a2a — Agent Card Signer
 *
 * Signs an AgentCard using JWS ES256 (ECDSA P-256 + SHA-256) via Web Crypto API.
 * The signature is stored as a JWS compact serialization in `card.signatures[]`.
 *
 * Wire format (A2A v1.0):
 *   AgentCardSignature {
 *     algorithm: "ES256"
 *     keyId: "<URL to JWKS or key identifier>"
 *     signature: "<JWS compact: base64url(header).base64url(payload).base64url(sig)>"
 *   }
 *
 * The signed payload is the canonical JSON of the card body WITHOUT the
 * `signatures` field. This means signature verification can be done even when
 * the card already carries other signatures.
 */

import type { AgentCard, AgentCardSignature } from '@weaveintel/core';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function base64urlEncode(data: Uint8Array | ArrayBuffer): string {
  const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  let b64 = btoa(String.fromCharCode(...buf));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    s.length + ((4 - (s.length % 4)) % 4),
    '=',
  );
  const bin = atob(padded);
  return new Uint8Array([...bin].map((c) => c.charCodeAt(0)));
}

function cardPayload(card: AgentCard): Uint8Array {
  // Canonical payload: card without signatures field, deterministic key order
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { signatures: _omit, ...rest } = card as AgentCard & { signatures?: unknown };
  return new TextEncoder().encode(JSON.stringify(rest));
}

// ─── Sign ─────────────────────────────────────────────────────────────────────

/**
 * Sign an agent card with an ES256 private key.
 *
 * @param card      The card to sign (signatures field, if present, is excluded from payload)
 * @param privateKey An `extractable` ECDSA P-256 CryptoKey
 * @param keyId     Identifier or JWKS URL for the corresponding public key
 * @returns A new card with a `signatures` array that includes this signature
 */
export async function signAgentCard(
  card: AgentCard,
  privateKey: CryptoKey,
  keyId: string,
): Promise<AgentCard> {
  const headerJson = JSON.stringify({ alg: 'ES256', kid: keyId });
  const encodedHeader = base64urlEncode(new TextEncoder().encode(headerJson));
  const encodedPayload = base64urlEncode(cardPayload(card));

  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);

  const rawSig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privateKey,
    signingInput as unknown as ArrayBuffer,
  );

  const jws = `${encodedHeader}.${encodedPayload}.${base64urlEncode(rawSig)}`;

  const newSig: AgentCardSignature = {
    algorithm: 'ES256',
    keyId,
    signature: jws,
  };

  const existing = card.signatures ?? [];
  return {
    ...card,
    signatures: [...existing, newSig],
  };
}

// ─── Verify ───────────────────────────────────────────────────────────────────

export interface CardVerificationResult {
  readonly valid: boolean;
  readonly reason?: string;
  readonly keyId?: string;
}

/**
 * Verify all signatures on an agent card.
 *
 * @param card         The card to verify
 * @param getPublicKey Callback that resolves a CryptoKey given a keyId.
 *                     Return null if the key is unknown.
 * @returns Result with `valid: true` if every signature passes (or there are none)
 */
export async function verifyAgentCard(
  card: AgentCard,
  getPublicKey: (keyId: string) => Promise<CryptoKey | null>,
): Promise<CardVerificationResult> {
  if (!card.signatures || card.signatures.length === 0) {
    return { valid: true, reason: 'no signatures present' };
  }

  const payload = cardPayload(card);

  for (const sig of card.signatures) {
    if (sig.algorithm !== 'ES256') {
      return { valid: false, reason: `unsupported algorithm: ${sig.algorithm}`, keyId: sig.keyId };
    }

    const parts = sig.signature.split('.');
    if (parts.length !== 3) {
      return { valid: false, reason: 'malformed JWS compact', keyId: sig.keyId };
    }

    const encodedHeader = parts[0]!;
    const encodedPayload = parts[1]!;
    const encodedSig = parts[2]!;

    // Verify payload matches
    const sigPayload = base64urlDecode(encodedPayload);
    if (!sigPayload.every((b, i) => b === payload[i]) || sigPayload.length !== payload.length) {
      return { valid: false, reason: 'payload mismatch', keyId: sig.keyId };
    }

    const pubKey = await getPublicKey(sig.keyId);
    if (!pubKey) {
      return { valid: false, reason: `unknown key: ${sig.keyId}`, keyId: sig.keyId };
    }

    const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
    const rawSig = base64urlDecode(encodedSig);

    let ok: boolean;
    try {
      ok = await crypto.subtle.verify(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        pubKey,
        rawSig as unknown as ArrayBuffer,
        signingInput as unknown as ArrayBuffer,
      );
    } catch (err) {
      return {
        valid: false,
        reason: `verification error: ${err instanceof Error ? err.message : String(err)}`,
        keyId: sig.keyId,
      };
    }

    if (!ok) {
      return { valid: false, reason: 'signature verification failed', keyId: sig.keyId };
    }
  }

  return { valid: true };
}

// ─── Key generation helper (for tests / dev tooling) ─────────────────────────

/**
 * Generate a fresh P-256 key pair for signing agent cards.
 * Both keys are extractable for serialization in test environments.
 */
export async function generateCardSigningKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
}
