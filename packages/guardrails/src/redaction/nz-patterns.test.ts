/**
 * New Zealand identifiers are redacted by built-in patterns (platform-architecture §7.4 item 6;
 * GAPS G-WI-13). Before this the built-ins were email, US phone, SSN, card, IPv4 and UUID only,
 * and asking for `nz_ird` threw "Unknown builtin pattern".
 */
import { describe, expect, it } from 'vitest';
import { weaveContext } from '@weaveintel/core';
import { weaveRedactor } from './redactor.js';

const nz = weaveRedactor({
  patterns: ['nz_ird', 'nz_mobile', 'nz_nhi', 'nz_passport'].map((n) => ({ name: n, type: 'builtin' as const })),
});

async function redact(text: string) {
  return nz.redact(weaveContext(), text);
}

describe('NZ built-in redaction patterns', () => {
  it('redacts an IRD number with a valid check digit, in any common layout', async () => {
    for (const ird of ['49-091-850', '49091850', '136-410-132', '35 901 981']) {
      const r = await redact(`My IRD is ${ird}.`);
      expect(r.redacted).toBe('My IRD is [NZ_IRD].');
    }
  });

  it('leaves numbers that fail the IRD check digit or range alone', async () => {
    for (const n of ['136-410-133', '9125568', '49091851']) {
      const r = await redact(`Ref ${n}`);
      expect(r.redacted).toBe(`Ref ${n}`);
    }
  });

  it('redacts NZ mobile numbers in local and international form', async () => {
    for (const m of ['021 123 4567', '0271234567', '+64 22 123 4567', '+6429123456', '020-123-45678']) {
      const r = await redact(`call ${m} now`);
      expect(r.redacted).toBe('call [NZ_MOBILE] now');
    }
    expect((await redact('landline 09 123 4567')).redacted).toBe('landline 09 123 4567');
  });

  it('redacts an NHI with a valid check digit and the new-format NHI', async () => {
    expect((await redact('NHI ZZZ0016')).redacted).toBe('NHI [NZ_NHI]');
    expect((await redact('NHI ZZZ0017')).redacted).toBe('NHI ZZZ0017');
    expect((await redact('NHI ALU18KZ')).redacted).toBe('NHI [NZ_NHI]');
    // I and O never appear in an NHI.
    expect((await redact('INC1234')).redacted).toBe('INC1234');
  });

  it('redacts an NZ passport number', async () => {
    expect((await redact('passport LA123456 expires')).redacted).toBe('passport [NZ_PASSPORT] expires');
  });
});
