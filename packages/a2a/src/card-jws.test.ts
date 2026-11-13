/**
 * Agent card signatures in the A2A wire form (`{ protected, signature, header? }`: a JWS with a detached
 * payload, the payload being the RFC 8785 canonical JSON of the card without `signatures`), verified against
 * a published JWKS.
 *
 * Rule R-A2A1: the card verifies against the published JWKS; tampering any field fails verification.
 */

import { describe, it, expect } from 'vitest';
import type { AgentCard } from '@weaveintel/core';
import {
  canonicalizeJson,
  signAgentCardJws,
  verifyAgentCardJws,
  exportCardSigningJwk,
  buildCardJwks,
  type CardJwks,
} from './card-jws.js';
import { generateCardSigningKeyPair } from './card-signer.js';
import { withV03Compat } from './card-v03.js';

const JKU = 'https://tenant-a.example.com/.well-known/jwks.json';

function card(): AgentCard {
  return {
    name: 'Service desk agent',
    description: 'Triage incidents',
    version: '1.0.0',
    skills: [
      { id: 'triage-incident', name: 'Triage', description: 'Suggest a category', tags: ['itsm'] },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: true,
      extendedAgentCard: false,
      stateTransitionHistory: false,
    },
    supportedInterfaces: [
      {
        url: 'https://tenant-a.example.com/a2a/v1',
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
        tenant: 'tenant-a',
      },
    ],
    provider: { organization: 'Example', url: 'https://example.com' },
  };
}

function b64uJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function keyAndJwks(kid = 'card-key-1'): Promise<{ privateKey: CryptoKey; jwks: CardJwks }> {
  const { privateKey, publicKey } = await generateCardSigningKeyPair();
  return { privateKey, jwks: buildCardJwks([await exportCardSigningJwk(publicKey, kid)]) };
}

describe('[JCS] canonicalizeJson (RFC 8785)', () => {
  it('sorts keys at every level and drops whitespace', () => {
    expect(canonicalizeJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('gives the same text for the same object built in a different key order', () => {
    expect(canonicalizeJson({ x: 1, y: [true, null] })).toBe(
      canonicalizeJson({ y: [true, null], x: 1 }),
    );
  });

  it('serialises numbers and strings the ECMAScript way', () => {
    expect(canonicalizeJson([1e21, 0.1, -0, 'é\n"\u0001'])).toBe('[1e+21,0.1,0,"é\\n\\"\\u0001"]');
  });

  it('sorts keys by UTF-16 code units', () => {
    expect(canonicalizeJson({ '€': 1, '\r': 2, '😀': 3, a: 4 })).toBe(
      '{"\\r":2,"a":4,"€":1,"😀":3}',
    );
  });

  it('omits undefined object members', () => {
    expect(canonicalizeJson({ a: undefined, b: 2 })).toBe('{"b":2}');
  });

  it('refuses a number JSON cannot carry', () => {
    expect(() => canonicalizeJson({ a: Number.NaN })).toThrow(/finite/);
    expect(() => canonicalizeJson({ a: Infinity })).toThrow(/finite/);
  });

  it('refuses a value JSON cannot carry', () => {
    expect(() => canonicalizeJson({ a: () => 1 })).toThrow(/JSON/);
    expect(() => canonicalizeJson({ a: 1n })).toThrow(/JSON/);
  });
});

describe('[JWS] signAgentCardJws', () => {
  it('adds a signature in the A2A wire form with ES256, kid and jku in the protected header', async () => {
    const { privateKey } = await keyAndJwks();
    const signed = await signAgentCardJws(card(), privateKey, { kid: 'card-key-1', jku: JKU });
    expect(signed.signatures).toHaveLength(1);
    const sig = signed.signatures[0]!;
    expect(Object.keys(sig).sort()).toEqual(['protected', 'signature']);
    const header = JSON.parse(Buffer.from(sig.protected, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(header).toEqual({ alg: 'ES256', typ: 'JOSE', kid: 'card-key-1', jku: JKU });
    // raw r||s, 64 bytes for P-256
    expect(Buffer.from(sig.signature, 'base64url')).toHaveLength(64);
  });

  it('signs a card that carries the v0.3 fields, and the result verifies', async () => {
    const { privateKey, jwks } = await keyAndJwks();
    const signed = await signAgentCardJws(withV03Compat(card()), privateKey, {
      kid: 'card-key-1',
      jku: JKU,
    });
    expect(signed.protocolVersion).toBe('0.3.0');
    expect(await verifyAgentCardJws(signed, { jwks })).toMatchObject({
      valid: true,
      kid: 'card-key-1',
    });
  });

  it('refuses a key that is not ECDSA P-256', async () => {
    const hmac = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    await expect(signAgentCardJws(card(), hmac, { kid: 'k' })).rejects.toThrow(/P-256/);
  });

  it('refuses an empty kid', async () => {
    const { privateKey } = await keyAndJwks();
    await expect(signAgentCardJws(card(), privateKey, { kid: '' })).rejects.toThrow(/kid/);
  });
});

describe('[JWKS] exportCardSigningJwk / buildCardJwks', () => {
  it('publishes only the public members with kid, alg and use', async () => {
    const { publicKey } = await generateCardSigningKeyPair();
    const jwk = await exportCardSigningJwk(publicKey, 'k1');
    expect(Object.keys(jwk).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: 'k1' });
  });

  it('refuses to export a private key', async () => {
    const { privateKey } = await generateCardSigningKeyPair();
    await expect(exportCardSigningJwk(privateKey, 'k1')).rejects.toThrow(/public/);
  });

  it('refuses a JWKS entry that carries a private member', async () => {
    const { privateKey } = await generateCardSigningKeyPair();
    const full = await crypto.subtle.exportKey('jwk', privateKey);
    expect(() =>
      buildCardJwks([{ ...full, kid: 'k1', alg: 'ES256', use: 'sig' } as never]),
    ).toThrow(/private/);
  });

  it('refuses two keys with the same kid', async () => {
    const a = await exportCardSigningJwk((await generateCardSigningKeyPair()).publicKey, 'same');
    const b = await exportCardSigningJwk((await generateCardSigningKeyPair()).publicKey, 'same');
    expect(() => buildCardJwks([a, b])).toThrow(/kid/);
  });
});

describe('[R-A2A1] verifyAgentCardJws', () => {
  it('verifies a signed card against the published JWKS', async () => {
    const { privateKey, jwks } = await keyAndJwks();
    const signed = await signAgentCardJws(card(), privateKey, { kid: 'card-key-1', jku: JKU });
    expect(await verifyAgentCardJws(signed, { jwks, allowedJku: [JKU] })).toEqual({
      valid: true,
      kid: 'card-key-1',
    });
  });

  it('verifies after a JSON round trip that reorders nothing and after one that reorders keys', async () => {
    const { privateKey, jwks } = await keyAndJwks();
    const signed = await signAgentCardJws(card(), privateKey, { kid: 'card-key-1' });
    const roundTrip = JSON.parse(JSON.stringify(signed)) as Record<string, unknown>;
    expect((await verifyAgentCardJws(roundTrip, { jwks })).valid).toBe(true);
    const reordered = Object.fromEntries(Object.entries(roundTrip).reverse());
    expect((await verifyAgentCardJws(reordered, { jwks })).valid).toBe(true);
  });

  it('fails when any top-level field is tampered with', async () => {
    const { privateKey, jwks } = await keyAndJwks();
    const signed = await signAgentCardJws(withV03Compat(card()), privateKey, { kid: 'card-key-1' });
    const fields = Object.keys(signed).filter((k) => k !== 'signatures');
    expect(fields.length).toBeGreaterThan(8);
    for (const field of fields) {
      const tampered = { ...signed, [field]: field === 'skills' ? [] : 'tampered' };
      const result = await verifyAgentCardJws(tampered, { jwks });
      expect({ field, ...result }).toMatchObject({ field, valid: false, reason: 'bad-signature' });
    }
  });

  it('fails when a nested field is tampered with (the interface URL)', async () => {
    const { privateKey, jwks } = await keyAndJwks();
    const signed = await signAgentCardJws(card(), privateKey, { kid: 'card-key-1' });
    const tampered = {
      ...signed,
      supportedInterfaces: [
        { ...signed.supportedInterfaces[0]!, url: 'https://attacker.example.net/a2a' },
      ],
    };
    expect(await verifyAgentCardJws(tampered, { jwks })).toMatchObject({
      valid: false,
      reason: 'bad-signature',
    });
  });

  it('fails when a field is added', async () => {
    const { privateKey, jwks } = await keyAndJwks();
    const signed = await signAgentCardJws(card(), privateKey, { kid: 'card-key-1' });
    expect(
      await verifyAgentCardJws(
        { ...signed, iconUrl: 'https://attacker.example.net/i.png' },
        { jwks },
      ),
    ).toMatchObject({ valid: false, reason: 'bad-signature' });
  });

  it('refuses an unsigned card', async () => {
    const { jwks } = await keyAndJwks();
    expect(await verifyAgentCardJws(card(), { jwks })).toEqual({
      valid: false,
      reason: 'unsigned',
    });
    expect(await verifyAgentCardJws({ ...card(), signatures: [] }, { jwks })).toEqual({
      valid: false,
      reason: 'unsigned',
    });
  });

  it('refuses a card signed by a key that is not in the JWKS', async () => {
    const { jwks } = await keyAndJwks('card-key-1');
    const other = await generateCardSigningKeyPair();
    const signed = await signAgentCardJws(card(), other.privateKey, { kid: 'card-key-1' });
    expect(await verifyAgentCardJws(signed, { jwks })).toMatchObject({
      valid: false,
      reason: 'bad-signature',
    });
    const unknownKid = await signAgentCardJws(card(), other.privateKey, { kid: 'card-key-9' });
    expect(await verifyAgentCardJws(unknownKid, { jwks })).toMatchObject({
      valid: false,
      reason: 'unknown-key',
    });
  });

  it('refuses alg "none" and HMAC algorithms in the protected header', async () => {
    const { jwks } = await keyAndJwks();
    for (const alg of ['none', 'HS256', 'RS256']) {
      const forged = {
        ...card(),
        signatures: [{ protected: b64uJson({ alg, kid: 'card-key-1' }), signature: '' }],
      };
      expect(await verifyAgentCardJws(forged, { jwks })).toMatchObject({
        valid: false,
        reason: 'unsupported-alg',
      });
    }
  });

  it('refuses a protected header with critical extensions it does not understand', async () => {
    const { privateKey, jwks } = await keyAndJwks();
    const signed = await signAgentCardJws(card(), privateKey, { kid: 'card-key-1' });
    const crit = {
      ...signed,
      signatures: [
        {
          ...signed.signatures[0]!,
          protected: b64uJson({ alg: 'ES256', kid: 'card-key-1', crit: ['b64'], b64: false }),
        },
      ],
    };
    expect(await verifyAgentCardJws(crit, { jwks })).toMatchObject({
      valid: false,
      reason: 'malformed',
    });
  });

  it('refuses a jku that is not one the verifier trusts', async () => {
    const { privateKey, jwks } = await keyAndJwks();
    const signed = await signAgentCardJws(card(), privateKey, {
      kid: 'card-key-1',
      jku: 'https://attacker.example.net/jwks.json',
    });
    expect(await verifyAgentCardJws(signed, { jwks, allowedJku: [JKU] })).toMatchObject({
      valid: false,
      reason: 'jku-not-trusted',
    });
  });

  it('refuses a malformed signature entry', async () => {
    const { jwks } = await keyAndJwks();
    for (const entry of [
      { protected: '!!', signature: 'x' },
      { protected: b64uJson('str'), signature: 'x' },
      { signature: 'x' },
      'x',
    ]) {
      const result = await verifyAgentCardJws({ ...card(), signatures: [entry] }, { jwks });
      expect(result).toMatchObject({ valid: false, reason: 'malformed' });
    }
  });

  it('does not count the older compact signature form as a signature', async () => {
    const { jwks } = await keyAndJwks();
    const legacy = {
      ...card(),
      signatures: [{ algorithm: 'ES256', keyId: 'card-key-1', signature: 'a.b.c' }],
    };
    expect(await verifyAgentCardJws(legacy, { jwks })).toMatchObject({ valid: false });
  });

  it('accepts a card with two signatures when one is from a trusted key', async () => {
    const { privateKey, jwks } = await keyAndJwks('card-key-1');
    const other = await generateCardSigningKeyPair();
    const once = await signAgentCardJws(card(), other.privateKey, { kid: 'registry-key' });
    const twice = await signAgentCardJws(once, privateKey, { kid: 'card-key-1' });
    expect(twice.signatures).toHaveLength(2);
    expect(await verifyAgentCardJws(twice, { jwks })).toEqual({ valid: true, kid: 'card-key-1' });
  });

  it('refuses a JWKS key of the wrong type', async () => {
    const { privateKey } = await keyAndJwks();
    const signed = await signAgentCardJws(card(), privateKey, { kid: 'card-key-1' });
    const badJwks = {
      keys: [{ kty: 'RSA', kid: 'card-key-1', n: 'AQAB', e: 'AQAB' }],
    } as unknown as CardJwks;
    expect(await verifyAgentCardJws(signed, { jwks: badJwks })).toMatchObject({
      valid: false,
      reason: 'unknown-key',
    });
  });
});
