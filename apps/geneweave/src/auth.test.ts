import { describe, expect, it } from 'vitest';
import { randomBytes, scryptSync } from 'node:crypto';
import { hashPassword, verifyPasswordDetailed } from './auth.js';

describe('password hashing', () => {
  it('writes current scrypt v2 password format and verifies without migration', async () => {
    const hash = await hashPassword('Sup3rStr0ng!');
    expect(hash.startsWith('scrypt$v2$')).toBe(true);

    const result = await verifyPasswordDetailed('Sup3rStr0ng!', hash);
    expect(result).toEqual({ ok: true, needsRehash: false });
  });

  it('accepts legacy password hashes and flags them for lazy migration', async () => {
    const salt = randomBytes(32).toString('hex');
    const legacyHash = scryptSync('legacy-pass', salt, 64).toString('hex');
    const stored = `${salt}:${legacyHash}`;

    const result = await verifyPasswordDetailed('legacy-pass', stored);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(true);
  });

  it('rejects wrong passwords', async () => {
    const hash = await hashPassword('CorrectHorseBatteryStaple');
    const result = await verifyPasswordDetailed('WrongPassword', hash);
    expect(result).toEqual({ ok: false, needsRehash: false });
  });
});
