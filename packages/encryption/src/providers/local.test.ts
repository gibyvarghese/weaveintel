import { randomBytes } from 'node:crypto';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { LocalKmsProvider, loadMasterKeyFromEnv } from './local.js';
import { AeadError, KmsUnavailableError } from '../errors.js';

describe('LocalKmsProvider', () => {
  it('wrap/unwrap round-trips a 32-byte key', async () => {
    const provider = new LocalKmsProvider({ masterKey: randomBytes(32) });
    const dek = randomBytes(32);
    const wrapped = await provider.wrap(await provider.rootKeyId('t1'), dek);
    expect(wrapped.alg).toBe('AES-GCM');
    const unwrapped = await provider.unwrap(wrapped);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  it('rejects non-32-byte master key', () => {
    expect(() => new LocalKmsProvider({ masterKey: randomBytes(16) })).toThrow(KmsUnavailableError);
  });

  it('rejects non-32-byte plaintext at wrap time', async () => {
    const provider = new LocalKmsProvider({ masterKey: randomBytes(32) });
    await expect(provider.wrap('local:default', randomBytes(16))).rejects.toThrow(AeadError);
  });

  it('unwrap fails closed on tampered wrapped key', async () => {
    const provider = new LocalKmsProvider({ masterKey: randomBytes(32) });
    const wrapped = await provider.wrap('local:default', randomBytes(32));
    const tampered = { ...wrapped, ciphertext: Buffer.concat([wrapped.ciphertext]) };
    tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 0xff;
    await expect(provider.unwrap(tampered)).rejects.toThrow(AeadError);
  });
});

describe('loadMasterKeyFromEnv', () => {
  const ENV = 'WEAVE_TEST_MASTER_KEY';
  beforeEach(() => {
    delete process.env[ENV];
  });
  afterEach(() => {
    delete process.env[ENV];
  });

  it('decodes hex 64-char keys', () => {
    process.env[ENV] = randomBytes(32).toString('hex');
    const out = loadMasterKeyFromEnv({ envVar: ENV });
    expect(out.key.length).toBe(32);
    expect(out.source).toBe('env');
  });

  it('decodes base64 keys', () => {
    process.env[ENV] = randomBytes(32).toString('base64');
    const out = loadMasterKeyFromEnv({ envVar: ENV });
    expect(out.key.length).toBe(32);
  });

  it('throws when env missing and dev gen disabled', () => {
    expect(() => loadMasterKeyFromEnv({ envVar: ENV })).toThrow(KmsUnavailableError);
  });

  it('generates random key when devGenerateIfMissing=true', () => {
    const out = loadMasterKeyFromEnv({ envVar: ENV, devGenerateIfMissing: true });
    expect(out.key.length).toBe(32);
    expect(out.source).toBe('dev-generated');
  });

  it('rejects wrong-length env material', () => {
    process.env[ENV] = 'short';
    expect(() => loadMasterKeyFromEnv({ envVar: ENV })).toThrow(KmsUnavailableError);
  });
});
