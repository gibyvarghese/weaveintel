import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildAad,
  decryptValue,
  encryptValue,
  isEncrypted,
  parseSentinel,
  SENTINEL_PREFIX,
} from './envelope.js';
import { AeadError, CiphertextFormatError } from './errors.js';

const aadParts = {
  tenantId: 't1',
  table: 'messages',
  column: 'content',
  rowId: 'r1',
  epoch: 1,
} as const;

describe('envelope', () => {
  it('round-trips utf8 plaintext', () => {
    const dek = randomBytes(32);
    const ct = encryptValue({ plaintext: Buffer.from('hello world'), dek, aad: aadParts });
    expect(ct.startsWith(SENTINEL_PREFIX)).toBe(true);
    const pt = decryptValue({ ciphertext: ct, dek, aad: aadParts });
    expect(pt.toString('utf8')).toBe('hello world');
  });

  it('isEncrypted only matches sentinel-prefixed strings', () => {
    expect(isEncrypted('plain')).toBe(false);
    expect(isEncrypted(`${SENTINEL_PREFIX}1:aaaa:bbbb`)).toBe(true);
    expect(isEncrypted(123)).toBe(false);
  });

  it('fails closed on AAD mismatch (different tenant)', () => {
    const dek = randomBytes(32);
    const ct = encryptValue({ plaintext: Buffer.from('secret'), dek, aad: aadParts });
    expect(() =>
      decryptValue({ ciphertext: ct, dek, aad: { ...aadParts, tenantId: 't2' } }),
    ).toThrow(AeadError);
  });

  it('fails closed on AAD mismatch (different column)', () => {
    const dek = randomBytes(32);
    const ct = encryptValue({ plaintext: Buffer.from('x'), dek, aad: aadParts });
    expect(() =>
      decryptValue({ ciphertext: ct, dek, aad: { ...aadParts, column: 'metadata' } }),
    ).toThrow(AeadError);
  });

  it('fails closed on tampered ciphertext', () => {
    const dek = randomBytes(32);
    const ct = encryptValue({ plaintext: Buffer.from('x'), dek, aad: aadParts });
    // Flip one base64 character in the ct segment.
    const idx = ct.length - 4;
    const tampered = ct.slice(0, idx) + (ct.charAt(idx) === 'A' ? 'B' : 'A') + ct.slice(idx + 1);
    expect(() => decryptValue({ ciphertext: tampered, dek, aad: aadParts })).toThrow(AeadError);
  });

  it('rejects malformed sentinels', () => {
    expect(() => parseSentinel('not-prefixed')).toThrow(CiphertextFormatError);
    expect(() => parseSentinel(`${SENTINEL_PREFIX}only:two`)).toThrow(CiphertextFormatError);
    expect(() => parseSentinel(`${SENTINEL_PREFIX}-1:aaaa:bbbb`)).toThrow(CiphertextFormatError);
  });

  it('encrypt rejects non-32-byte DEKs', () => {
    expect(() => encryptValue({ plaintext: Buffer.from('x'), dek: randomBytes(16), aad: aadParts })).toThrow(
      AeadError,
    );
  });

  it('buildAad serializes parts in canonical order', () => {
    expect(buildAad(aadParts).toString('utf8')).toBe('t1|messages|content|r1|1');
  });
});
