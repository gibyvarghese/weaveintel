// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { base64UrlEncode } from './canonical.js';
import { body, NOW, step, ticket } from './test-fixtures.js';
import {
  checkChain,
  createWebCryptoTicketVerifier,
  hashChain,
  hashFieldList,
  sealTicket,
  ticketSigningPayload,
  verifyTicket,
  type RoutingTicket,
} from './ticket.js';

const web = { shell: 'web' as const, now: NOW };

async function signed(t: RoutingTicket) {
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'Ed25519' },
      keys.privateKey,
      new Uint8Array(ticketSigningPayload(t)),
    ),
  );
  return {
    ticket: { ...t, signature: base64UrlEncode(sig) },
    verifier: createWebCryptoTicketVerifier(keys.publicKey),
  };
}

describe('hashes', () => {
  it('the field-list hash ignores order and repeats, and changes when a field is added', async () => {
    const a = await hashFieldList(['b', 'a']);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashFieldList(['a', 'b', 'a'])).toBe(a);
    expect(await hashFieldList(['a', 'b', 'c'])).not.toBe(a);
  });

  it('the chain hash changes with every step property and with local-only', async () => {
    const base = [
      step(1, 'browser-wasm', 'clf@2.1', { files: [{ name: 'm.onnx', sha256: 'aa', bytes: 10 }] }),
      step(2, 'tenant-hosted'),
    ];
    const h = await hashChain(base);
    const variants = [
      [{ ...base[0]!, engineClass: 'chrome-builtin' as const }, base[1]!],
      [{ ...base[0]!, modelKey: 'clf@2.2' }, base[1]!],
      [{ ...base[0]!, timeoutMs: 999 }, base[1]!],
      [{ ...base[0]!, minConfidence: 0.1 }, base[1]!],
      [{ ...base[0]!, maxDownloadMb: 5 }, base[1]!],
      [{ ...base[0]!, offlineOk: true }, base[1]!],
      [{ ...base[0]!, files: [{ name: 'm.onnx', sha256: 'ab', bytes: 10 }] }, base[1]!],
      [base[0]!, { ...base[1]!, engineClass: 'platform-hosted' as const }],
    ];
    for (const v of variants) expect(await hashChain(v)).not.toBe(h);
    expect(await hashChain(base, true)).not.toBe(h);
    // Order of the array is not what is hashed: position is.
    expect(await hashChain([base[1]!, base[0]!])).toBe(h);
  });
});

describe('verifyTicket', () => {
  it('accepts a sealed, unexpired ticket', async () => {
    expect(await verifyTicket(await ticket(), web)).toEqual({ ok: true });
  });

  it('refuses a ticket whose chain was changed after sealing (a tampered chain hash)', async () => {
    const t = await ticket({
      steps: [step(1, 'stub', 'model-a', { minConfidence: 0.8 }), step(2, 'tenant-hosted')],
    });
    const lowered: RoutingTicket = {
      ...t,
      steps: [{ ...t.steps[0]!, minConfidence: 0 }, t.steps[1]!],
    };
    expect(await verifyTicket(lowered, web)).toMatchObject({
      ok: false,
      code: 'chain_hash_mismatch',
    });
    const extraStep: RoutingTicket = {
      ...t,
      steps: [step(1, 'stub'), step(2, 'chrome-builtin', 'prompt'), step(3, 'tenant-hosted')],
    };
    expect(await verifyTicket(extraStep, web)).toMatchObject({
      ok: false,
      code: 'chain_hash_mismatch',
    });
    const forgedHash: RoutingTicket = {
      ...t,
      chainHash: t.chainHash.replace(/^./, (c) => (c === '0' ? '1' : '0')),
    };
    expect(await verifyTicket(forgedHash, web)).toMatchObject({
      ok: false,
      code: 'chain_hash_mismatch',
    });
  });

  it('refuses a ticket whose field list was changed after sealing', async () => {
    const t = await ticket();
    expect(await verifyTicket({ ...t, fields: [...t.fields, 'salary'] }, web)).toMatchObject({
      ok: false,
      code: 'field_list_hash_mismatch',
    });
    expect(await verifyTicket({ ...t, fieldListHash: '0'.repeat(64) }, web)).toMatchObject({
      ok: false,
      code: 'field_list_hash_mismatch',
    });
  });

  it('refuses an expired ticket and an unreadable expiry', async () => {
    const t = await ticket();
    expect(await verifyTicket(t, { shell: 'web', now: NOW + 120_001 })).toMatchObject({
      ok: false,
      code: 'expired',
    });
    expect(await verifyTicket(await ticket({ expiresAt: 'soon' }), web)).toMatchObject({
      ok: false,
      code: 'malformed',
    });
  });

  it('refuses malformed input without throwing', async () => {
    const t = await ticket();
    for (const bad of [
      null,
      'x',
      42,
      {},
      { ...t, steps: 'x' },
      { ...t, fields: [1] },
      { ...t, record: null },
      { ...t, steps: [] },
    ]) {
      expect(await verifyTicket(bad, web)).toMatchObject({ ok: false, code: 'malformed' });
    }
    const unknownClass = {
      ...t,
      steps: [{ ...t.steps[0]!, engineClass: 'gpu-cluster' }, t.steps[1]!],
    };
    expect(await verifyTicket(unknownClass, web)).toMatchObject({ ok: false, code: 'malformed' });
  });

  it('refuses a chain that never ends on a hosted step, unless it was sealed local-only', async () => {
    const noEnd = await ticket({
      steps: [step(1, 'stub'), step(2, 'chrome-builtin', 'summarizer')],
    });
    expect(await verifyTicket(noEnd, web)).toMatchObject({ ok: false, code: 'no_hosted_end' });
    const localOnly = await ticket({
      localOnly: true,
      steps: [step(1, 'stub'), step(2, 'chrome-builtin', 'summarizer')],
    });
    expect(await verifyTicket(localOnly, web)).toEqual({ ok: true });
    // Flipping the flag on a sealed ticket is a chain change.
    expect(await verifyTicket({ ...noEnd, localOnly: true }, web)).toMatchObject({
      ok: false,
      code: 'chain_hash_mismatch',
    });
  });

  it('refuses a hosted step before a local one, and a local-only chain that has a hosted step', async () => {
    const t = await ticket({
      steps: [step(1, 'tenant-hosted'), step(2, 'stub'), step(3, 'platform-hosted')],
    });
    expect(await verifyTicket(t, web)).toMatchObject({ ok: false, code: 'hosted_not_last' });
    const lo = await ticket({
      localOnly: true,
      steps: [step(1, 'stub'), step(2, 'tenant-hosted')],
    });
    expect(await verifyTicket(lo, web)).toMatchObject({ ok: false, code: 'malformed' });
    const dup = await ticket({ steps: [step(1, 'stub'), step(1, 'tenant-hosted')] });
    expect(await verifyTicket(dup, web)).toMatchObject({ ok: false, code: 'malformed' });
  });

  it('refuses an engine the shell may never use (no local server for a web page)', async () => {
    const t = await ticket({ steps: [step(1, 'local-server', 'llama'), step(2, 'tenant-hosted')] });
    expect(await verifyTicket(t, web)).toMatchObject({
      ok: false,
      code: 'engine_not_allowed_on_shell',
    });
    expect(await verifyTicket(t, { shell: 'desktop', now: NOW })).toEqual({ ok: true });
  });

  it('checks the signature when the host gives a verifier', async () => {
    const { ticket: s, verifier } = await signed(await ticket());
    expect(
      await verifyTicket(s, { ...web, verifySignature: verifier, requireSignature: true }),
    ).toEqual({ ok: true });

    const badSig = { ...s, signature: s.signature!.slice(0, -4) + 'AAAA' };
    expect(await verifyTicket(badSig, { ...web, verifySignature: verifier })).toMatchObject({
      ok: false,
      code: 'signature_invalid',
    });
    expect(
      await verifyTicket({ ...s, signature: '%%%' }, { ...web, verifySignature: verifier }),
    ).toMatchObject({
      ok: false,
      code: 'signature_invalid',
    });

    // Someone who rewrites the chain AND recomputes the hashes still fails: the signature covers the hashes.
    const rehashed = await sealTicket({
      ...body(),
      steps: [step(1, 'stub', 'model-b'), step(2, 'tenant-hosted')],
    });
    expect(
      await verifyTicket(
        { ...rehashed, signature: s.signature },
        { ...web, verifySignature: verifier },
      ),
    ).toMatchObject({
      ok: false,
      code: 'signature_invalid',
    });
  });

  it('requires a signature only when asked to', async () => {
    const t = await ticket();
    expect(await verifyTicket(t, web)).toEqual({ ok: true });
    expect(await verifyTicket(t, { ...web, requireSignature: true })).toMatchObject({
      ok: false,
      code: 'signature_missing',
    });
  });
});

describe('checkChain (shared with the server when a task is saved)', () => {
  it('accepts local steps then hosted steps', () => {
    expect(
      checkChain([step(1, 'stub'), step(2, 'tenant-hosted'), step(3, 'platform-hosted')]),
    ).toEqual({ ok: true });
  });
  it('refuses a chain with no hosted end unless local-only', () => {
    expect(checkChain([step(1, 'stub')])).toMatchObject({ ok: false, code: 'no_hosted_end' });
    expect(checkChain([step(1, 'stub')], { localOnly: true })).toEqual({ ok: true });
  });
  it('refuses a local-server step for the web shell', () => {
    expect(
      checkChain([step(1, 'local-server'), step(2, 'tenant-hosted')], { shell: 'web' }),
    ).toMatchObject({
      ok: false,
      code: 'engine_not_allowed_on_shell',
    });
  });
});
