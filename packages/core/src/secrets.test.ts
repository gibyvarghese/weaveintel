/**
 * Phase 2 — Secret resolver unit tests.
 */
import { describe, it, expect } from 'vitest';
import {
  chainSecretResolvers,
  envSecretResolver,
  inMemorySecretResolver,
  requireSecret,
} from './secrets.js';

describe('envSecretResolver', () => {
  it('reads from injected env map', async () => {
    const r = envSecretResolver({ env: { FOO: 'bar' } });
    await expect(r.resolve('FOO')).resolves.toBe('bar');
    await expect(r.resolve('NOPE')).resolves.toBeUndefined();
  });

  it('applies prefix', async () => {
    const r = envSecretResolver({ prefix: 'WEAVE_', env: { WEAVE_TOKEN: 'tk' } });
    await expect(r.resolve('TOKEN')).resolves.toBe('tk');
  });

  it('strict mode throws on missing', async () => {
    const r = envSecretResolver({ env: {}, strict: true });
    await expect(r.resolve('MISSING')).rejects.toThrow(/missing required secret 'MISSING'/);
  });
});

describe('inMemorySecretResolver', () => {
  it('returns seeded values and supports mutation', async () => {
    const r = inMemorySecretResolver({ a: '1' });
    await expect(r.resolve('a')).resolves.toBe('1');
    r.set('b', '2');
    await expect(r.resolve('b')).resolves.toBe('2');
    r.delete('a');
    await expect(r.resolve('a')).resolves.toBeUndefined();
  });
});

describe('chainSecretResolvers', () => {
  it('first match wins', async () => {
    const a = inMemorySecretResolver({ X: 'fromA' });
    const b = inMemorySecretResolver({ X: 'fromB', Y: 'fromB' });
    const chain = chainSecretResolvers(a, b);
    await expect(chain.resolve('X')).resolves.toBe('fromA');
    await expect(chain.resolve('Y')).resolves.toBe('fromB');
    await expect(chain.resolve('Z')).resolves.toBeUndefined();
  });

  it('empty chain resolves undefined', async () => {
    const chain = chainSecretResolvers();
    await expect(chain.resolve('anything')).resolves.toBeUndefined();
  });
});

describe('requireSecret', () => {
  it('returns the value when present', async () => {
    const r = inMemorySecretResolver({ K: 'v' });
    await expect(requireSecret(r, 'K')).resolves.toBe('v');
  });

  it('throws a clear error when missing', async () => {
    const r = inMemorySecretResolver();
    await expect(requireSecret(r, 'K')).rejects.toThrow(/required secret 'K' is not available/);
  });

  it('throws a clear error on empty string', async () => {
    const r = inMemorySecretResolver({ K: '' });
    await expect(requireSecret(r, 'K')).rejects.toThrow(/required secret 'K' is not available/);
  });
});
