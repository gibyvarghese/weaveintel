import { describe, it, expect } from 'vitest';
import {
  canonicalize,
  generateAttestationSigningKey,
  loadAttestationSigningKey,
  fingerprintEd25519PublicKey,
  buildAuditChain,
  buildAndSignAttestation,
  verifyAttestation,
  type AuditEventLike,
  type BuildAttestationInput,
} from './attestation.js';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';

// ── Helpers ────────────────────────────────────────────────────

function makeInput(overrides: Partial<BuildAttestationInput> = {}): BuildAttestationInput {
  const signingKey = generateAttestationSigningKey();
  return {
    tenantId: 'tenant-1',
    host: 'test.example.com',
    fields: [{ table: 'users', column: 'email', required: true, classification: 'PII' }],
    kms: { providerId: 'local' },
    keyState: {
      activeKekId: 'kek-1',
      activeDekId: 'dek-1',
      activeBikId: 'bik-1',
      lastRotationAt: 1_000_000,
      retainedDekCount: 2,
      retainedBikCount: 1,
    },
    auditEvents: [],
    signingKey,
    now: 1_700_000_000_000,
    ...overrides,
  };
}

const SAMPLE_EVENTS: AuditEventLike[] = [
  { id: 'ev-1', eventKind: 'kek_create', createdAt: 100, details: null },
  { id: 'ev-2', eventKind: 'dek_create', createdAt: 200, details: { epoch: 1 } },
];

// ── canonicalize ───────────────────────────────────────────────

describe('canonicalize', () => {
  it('handles primitives', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('hello')).toBe('"hello"');
    expect(canonicalize(true)).toBe('true');
  });

  it('sorts object keys lexicographically', () => {
    expect(canonicalize({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('is stable for the same object regardless of insertion order', () => {
    const a = canonicalize({ b: 1, a: 2 });
    const b = canonicalize({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('handles nested objects', () => {
    expect(canonicalize({ x: { c: 1, a: 2 } })).toBe('{"x":{"a":2,"c":1}}');
  });
});

// ── generateAttestationSigningKey ──────────────────────────────

describe('generateAttestationSigningKey', () => {
  it('returns a key with a fingerprint', () => {
    const k = generateAttestationSigningKey();
    expect(k.fingerprint).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(k.privateKey.asymmetricKeyType).toBe('ed25519');
    expect(k.publicKey.asymmetricKeyType).toBe('ed25519');
  });

  it('generates distinct fingerprints each time', () => {
    const a = generateAttestationSigningKey();
    const b = generateAttestationSigningKey();
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

// ── loadAttestationSigningKey ──────────────────────────────────

describe('loadAttestationSigningKey', () => {
  it('round-trips a generated key via PEM', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const loaded = loadAttestationSigningKey(pem);
    expect(loaded.fingerprint).toBe(fingerprintEd25519PublicKey(createPublicKey(privateKey)));
  });

  it('throws on non-Ed25519 key', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(() => loadAttestationSigningKey(pem)).toThrow('Ed25519');
  });
});

// ── buildAuditChain ────────────────────────────────────────────

describe('buildAuditChain', () => {
  it('returns a deterministic tip for empty events', () => {
    const { entries, tip } = buildAuditChain([]);
    expect(entries).toHaveLength(0);
    expect(tip).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces one entry per event, sorted by createdAt', () => {
    const { entries } = buildAuditChain([...SAMPLE_EVENTS].reverse());
    expect(entries[0]!.eventKind).toBe('kek_create');
    expect(entries[1]!.eventKind).toBe('dek_create');
  });

  it('is deterministic given the same events in any order', () => {
    const { tip: a } = buildAuditChain(SAMPLE_EVENTS);
    const { tip: b } = buildAuditChain([...SAMPLE_EVENTS].reverse());
    expect(a).toBe(b);
  });

  it('produces different tips for different events', () => {
    const { tip: a } = buildAuditChain(SAMPLE_EVENTS);
    const modified: AuditEventLike[] = [
      { id: 'ev-1', eventKind: 'kek_create', createdAt: 100, details: null },
      { id: 'ev-2', eventKind: 'dek_rotate', createdAt: 200, details: null },
    ];
    const { tip: b } = buildAuditChain(modified);
    expect(a).not.toBe(b);
  });
});

// ── buildAndSignAttestation + verifyAttestation ─────────────────

describe('buildAndSignAttestation / verifyAttestation', () => {
  it('produces a signature that verifies', () => {
    const input = makeInput({ auditEvents: SAMPLE_EVENTS });
    const signed = buildAndSignAttestation(input);
    const pubKeyPem = input.signingKey.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const result = verifyAttestation({ attestation: signed, publicKeyPem: pubKeyPem });
    expect(result.ok).toBe(true);
    expect(result.signingKeyFingerprintOk).toBe(true);
    expect(result.auditChainOk).toBe(true);
  });

  it('embeds the signing key fingerprint in the payload', () => {
    const input = makeInput();
    const signed = buildAndSignAttestation(input);
    expect(signed.payload.signingKeyFingerprint).toBe(input.signingKey.fingerprint);
  });

  it('sorts fields by table then column', () => {
    const input = makeInput({
      fields: [
        { table: 'users', column: 'ssn', required: true, classification: 'PII' },
        { table: 'accounts', column: 'balance', required: false, classification: 'FINANCIAL' },
        { table: 'users', column: 'email', required: true, classification: 'PII' },
      ],
    });
    const signed = buildAndSignAttestation(input);
    const tables = signed.payload.fields.map((f) => `${f.table}.${f.column}`);
    expect(tables).toEqual(['accounts.balance', 'users.email', 'users.ssn']);
  });

  it('fails to verify with a different public key', () => {
    const signed = buildAndSignAttestation(makeInput());
    const other = generateAttestationSigningKey();
    const wrongPem = other.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const result = verifyAttestation({ attestation: signed, publicKeyPem: wrongPem });
    expect(result.ok).toBe(false);
    expect(result.signingKeyFingerprintOk).toBe(false);
  });

  it('fails to verify if payload is tampered', () => {
    const input = makeInput();
    const signed = buildAndSignAttestation(input);
    const tampered = {
      ...signed,
      payload: { ...signed.payload, tenantId: 'evil-tenant' },
    };
    const pubKeyPem = input.signingKey.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const result = verifyAttestation({ attestation: tampered, publicKeyPem: pubKeyPem });
    expect(result.ok).toBe(false);
  });

  it('uses provided now for generatedAt', () => {
    const now = 9_999_999;
    const signed = buildAndSignAttestation(makeInput({ now }));
    expect(signed.payload.generatedAt).toBe(now);
  });
});
