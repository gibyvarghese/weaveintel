// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest';
import { classifyEngineError, EngineError } from './engine.js';
import { createStubEngine } from './engines/stub.js';
import type { DevicePolicy } from './probe.js';
import { NOW, step, ticket, WEB } from './test-fixtures.js';
import type { RoutingTicket } from './ticket.js';
import {
  fallbackSummary,
  toHostedFallback,
  toResultSubmission,
  walkChain,
  type WalkOptions,
} from './walker.js';

const now = () => NOW;
const input = { text: 'Bonjour, mon imprimante ne marche pas.' };

function walk(t: RoutingTicket, over: Partial<WalkOptions> = {}) {
  return walkChain({ ticket: t, engines: [createStubEngine()], input, device: WEB, now, ...over });
}

const roomyPolicy: DevicePolicy = {
  downloadBudgetMb: 500,
  requireUnmetered: true,
  minBatteryPct: 20,
  allowOffline: true,
};

describe('walkChain: the happy path', () => {
  it('answers from the first local step and builds an unattested submission', async () => {
    const r = await walk(await ticket());
    expect(r.kind).toBe('local');
    if (r.kind !== 'local') return;
    expect(r.position).toBe(1);
    expect(r.output).toEqual({ language: 'en' });
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ outcome: 'ok', engineClass: 'stub', attested: false });
    const sub = toResultSubmission(r);
    expect(sub).toMatchObject({
      ticketId: 'tkt-1',
      step: 1,
      provenance: { engineClass: 'stub', attested: false },
    });
  });

  it("hands only the ticket's fields to the engine", async () => {
    const stub = createStubEngine();
    await walk(await ticket(), {
      engines: [stub],
      input: { text: 'x', fields: { short_description: 'a', description: 'b', salary: '100000' } },
    });
    expect(stub.calls.run[0]!.input.fields).toEqual({ short_description: 'a', description: 'b' });
  });

  it('reports every attempt as it happens', async () => {
    const seen: string[] = [];
    await walk(
      await ticket({
        steps: [step(1, 'chrome-builtin', 'summarizer'), step(2, 'stub'), step(3, 'tenant-hosted')],
      }),
      {
        onAttempt: (a) => seen.push(`${a.position}:${a.outcome}`),
      },
    );
    expect(seen).toEqual(['1:skipped', '2:ok']);
  });
});

describe('walkChain: availability states', () => {
  const chain = () =>
    ticket({
      steps: [step(1, 'stub', 'model-a', { maxDownloadMb: 100 }), step(2, 'tenant-hosted')],
    });

  it('unavailable and downloading skip the step', async () => {
    for (const state of ['unavailable', 'downloading'] as const) {
      const stub = createStubEngine({ availability: state });
      const r = await walk(await chain(), { engines: [stub] });
      expect(r.kind).toBe('hosted');
      expect(r.attempts[0]).toMatchObject({ outcome: 'skipped', reason: 'unavailable' });
      expect(stub.calls.run).toHaveLength(0);
    }
  });

  it('a download with no yes from the person is refused, and run is never called', async () => {
    const stub = createStubEngine({ availability: { state: 'downloadable', downloadMb: 20 } });
    const r = await walk(await chain(), { engines: [stub], policy: roomyPolicy });
    expect(r.attempts[0]).toMatchObject({ outcome: 'skipped', reason: 'download_refused' });
    expect(stub.calls.run).toHaveLength(0);
    const no = await walk(await chain(), {
      engines: [stub],
      policy: roomyPolicy,
      confirmDownload: () => false,
    });
    expect(no.attempts[0]).toMatchObject({ reason: 'download_refused' });
    expect(stub.calls.run).toHaveLength(0);
  });

  it('a download over the step limit, over the device budget, or of unknown size is over budget', async () => {
    const yes = () => true;
    const big = createStubEngine({ availability: { state: 'downloadable', downloadMb: 150 } });
    expect(
      (await walk(await chain(), { engines: [big], policy: roomyPolicy, confirmDownload: yes }))
        .attempts[0],
    ).toMatchObject({ reason: 'over_budget' });
    const fits = createStubEngine({ availability: { state: 'downloadable', downloadMb: 50 } });
    expect(
      (
        await walk(await chain(), {
          engines: [fits],
          policy: roomyPolicy,
          confirmDownload: yes,
          device: { ...WEB, downloadedMb: 470 },
        })
      ).attempts[0],
    ).toMatchObject({ reason: 'over_budget' });
    const unknown = createStubEngine({ availability: 'downloadable' });
    expect(
      (await walk(await chain(), { engines: [unknown], policy: roomyPolicy, confirmDownload: yes }))
        .attempts[0],
    ).toMatchObject({ reason: 'over_budget' });
    // The default policy allows no downloads at all.
    expect(
      (await walk(await chain(), { engines: [fits], confirmDownload: yes })).attempts[0],
    ).toMatchObject({ reason: 'over_budget' });
  });

  it('a download on a metered connection is blocked by device policy', async () => {
    const stub = createStubEngine({ availability: { state: 'downloadable', downloadMb: 20 } });
    const r = await walk(await chain(), {
      engines: [stub],
      policy: roomyPolicy,
      confirmDownload: () => true,
      device: { ...WEB, metered: true },
    });
    expect(r.attempts[0]).toMatchObject({ outcome: 'skipped', reason: 'device_policy_blocked' });
  });

  it('a download that passes every gate runs with allowDownload', async () => {
    const stub = createStubEngine({ availability: { state: 'downloadable', downloadMb: 20 } });
    const ask = vi.fn(() => true);
    const r = await walk(await chain(), {
      engines: [stub],
      policy: roomyPolicy,
      confirmDownload: ask,
    });
    expect(r.kind).toBe('local');
    expect(ask).toHaveBeenCalledWith({ engineClass: 'stub', modelKey: 'model-a', downloadMb: 20 });
    expect(stub.calls.run[0]!.allowDownload).toBe(true);
  });

  it('an available engine runs without permission to download', async () => {
    const stub = createStubEngine();
    await walk(await chain(), { engines: [stub] });
    expect(stub.calls.run[0]!.allowDownload).toBe(false);
  });
});

describe('walkChain: failures fall through with their reason', () => {
  it('a slow run times out at the step limit', async () => {
    const slow = createStubEngine({ delayMs: 5_000 });
    const t = await ticket({
      steps: [step(1, 'stub', 'model-a', { timeoutMs: 30 }), step(2, 'tenant-hosted')],
    });
    const r = await walkChain({ ticket: t, engines: [slow], input, device: WEB, now });
    expect(r.kind).toBe('hosted');
    expect(r.attempts[0]).toMatchObject({ outcome: 'failed', reason: 'timeout' });
    expect(slow.calls.run[0]!.signal.aborted).toBe(true);
  });

  it('an availability check that hangs times out too', async () => {
    const hang = createStubEngine({ availability: () => new Promise(() => {}) });
    const t = await ticket({
      steps: [step(1, 'stub', 'model-a', { timeoutMs: 30 }), step(2, 'tenant-hosted')],
    });
    const r = await walkChain({ ticket: t, engines: [hang], input, device: WEB, now });
    expect(r.attempts[0]).toMatchObject({ outcome: 'skipped', reason: 'timeout' });
  });

  it('an output of the wrong shape is a schema violation', async () => {
    const bad = createStubEngine({ respond: () => ({ output: { language: 42 } }) });
    const r = await walk(await ticket(), { engines: [bad] });
    expect(r.kind).toBe('hosted');
    expect(r.attempts[0]).toMatchObject({ outcome: 'failed', reason: 'schema_violation' });
  });

  it("a value outside the field's choices is a schema violation", async () => {
    const t = await ticket({ task: 'field.suggest' });
    const bad = createStubEngine({
      respond: () => ({
        output: { field: 'priority', value: 'urgent!!', confidence: 0.9 },
        confidence: 0.9,
      }),
    });
    const r = await walk(t, {
      engines: [bad],
      input: { text: 'x', field: 'priority', choices: ['1', '2', '3'] },
    });
    expect(r.attempts[0]).toMatchObject({ reason: 'schema_violation' });
  });

  it('confidence under the step floor is low confidence; no score under a floor is low too', async () => {
    const t = await ticket({
      steps: [step(1, 'stub', 'model-a', { minConfidence: 0.8 }), step(2, 'tenant-hosted')],
    });
    const low = createStubEngine({
      respond: () => ({ output: { language: 'fr' }, confidence: 0.78 }),
    });
    expect((await walk(t, { engines: [low] })).attempts[0]).toMatchObject({
      outcome: 'failed',
      reason: 'low_confidence',
      confidence: 0.78,
    });
    const none = createStubEngine({ respond: () => ({ output: { language: 'fr' } }) });
    expect((await walk(t, { engines: [none] })).attempts[0]).toMatchObject({
      reason: 'low_confidence',
    });
    const high = createStubEngine({
      respond: () => ({ output: { language: 'fr' }, confidence: 0.85 }),
    });
    expect((await walk(t, { engines: [high] })).kind).toBe('local');
  });

  it('battery under the floor while not charging is the device-policy reason; charging lifts it', async () => {
    const stub = createStubEngine();
    const low = await walk(await ticket(), {
      engines: [stub],
      device: { ...WEB, batteryPct: 10, charging: false },
    });
    expect(low.attempts[0]).toMatchObject({ outcome: 'skipped', reason: 'device_policy_blocked' });
    expect(stub.calls.availability).toHaveLength(0);
    const charging = await walk(await ticket(), {
      engines: [stub],
      device: { ...WEB, batteryPct: 10, charging: true },
    });
    expect(charging.kind).toBe('local');
  });

  it('a browser that blocks the API by policy (NotAllowedError) is the device-policy reason', async () => {
    const blocked = createStubEngine({
      respond: () => {
        throw new DOMException('blocked by enterprise policy', 'NotAllowedError');
      },
    });
    expect((await walk(await ticket(), { engines: [blocked] })).attempts[0]).toMatchObject({
      outcome: 'failed',
      reason: 'device_policy_blocked',
    });
  });

  it('out of memory is its own reason', async () => {
    const oom = createStubEngine({
      respond: () => {
        throw new DOMException('no room', 'QuotaExceededError');
      },
    });
    expect((await walk(await ticket(), { engines: [oom] })).attempts[0]).toMatchObject({
      reason: 'out_of_memory',
    });
  });

  it('offline: the step and the policy must both allow it', async () => {
    const off = { ...WEB, online: false };
    const needsNet = await ticket();
    expect((await walk(needsNet, { device: off, policy: roomyPolicy })).attempts[0]).toMatchObject({
      reason: 'offline',
    });
    const offlineOk = await ticket({
      steps: [step(1, 'stub', 'model-a', { offlineOk: true }), step(2, 'tenant-hosted')],
    });
    expect((await walk(offlineOk, { device: off })).attempts[0]).toMatchObject({
      reason: 'offline',
    });
    expect((await walk(offlineOk, { device: off, policy: roomyPolicy })).kind).toBe('local');
  });

  it('no engine for the class, or an engine that does not do the task, is not applicable', async () => {
    const t = await ticket({
      steps: [step(1, 'browser-wasm', 'clf'), step(2, 'stub'), step(3, 'tenant-hosted')],
    });
    const r = await walk(t, { engines: [createStubEngine({ tasks: ['pii.detect'] })] });
    expect(r.attempts.map((a) => a.reason)).toEqual([
      'not_applicable',
      'not_applicable',
      undefined,
    ]);
  });

  it('input longer than the limit skips every local step', async () => {
    const stub = createStubEngine();
    const r = await walk(await ticket(), {
      engines: [stub],
      input: { text: 'x'.repeat(50) },
      maxInputChars: 10,
    });
    expect(r.kind).toBe('hosted');
    expect(r.attempts[0]).toMatchObject({ reason: 'not_applicable' });
    expect(stub.calls.availability).toHaveLength(0);
  });
});

describe('walkChain: the chain ends at hosted', () => {
  it('when every local step fails it hands the hosted end back, with the reasons in order (design example)', async () => {
    const t = await ticket({
      task: 'record.classify',
      steps: [
        step(1, 'browser-wasm', 'minilm-ticket-clf@2.1', { minConfidence: 0.8 }),
        step(2, 'chrome-builtin', 'prompt', { minConfidence: 0.8 }),
        step(3, 'tenant-hosted'),
        step(4, 'platform-hosted'),
      ],
    });
    const wasm = createStubEngine({
      engineClass: 'browser-wasm',
      respond: () => ({ output: { label: 'hardware' }, confidence: 0.78 }),
    });
    const r = await walkChain({
      ticket: t,
      engines: [wasm],
      input: { text: 'printer', choices: ['hardware', 'software'] },
      device: WEB,
      now,
    });
    expect(r.kind).toBe('hosted');
    if (r.kind !== 'hosted') return;
    expect(r.position).toBe(3);
    expect(r.engineClass).toBe('tenant-hosted');
    expect(fallbackSummary(r.attempts)).toEqual([
      'browser-wasm:low_confidence',
      'chrome-builtin:not_applicable',
    ]);
    expect(toHostedFallback(r)).toMatchObject({
      ticketId: 'tkt-1',
      step: 3,
      fallback: ['browser-wasm:low_confidence', 'chrome-builtin:not_applicable'],
    });
  });

  it('never runs an engine registered under a hosted class', async () => {
    const impostor = createStubEngine({ engineClass: 'tenant-hosted' });
    const t = await ticket({ steps: [step(1, 'tenant-hosted')] });
    const r = await walkChain({ ticket: t, engines: [impostor], input, device: WEB, now });
    expect(r.kind).toBe('hosted');
    expect(impostor.calls.availability).toHaveLength(0);
    expect(impostor.calls.run).toHaveLength(0);
  });

  it('refuses a chain that never ends on a hosted step, and runs nothing', async () => {
    const stub = createStubEngine();
    const t = await ticket({ steps: [step(1, 'stub')] });
    const r = await walk(t, { engines: [stub] });
    expect(r).toMatchObject({ kind: 'refused', code: 'no_hosted_end' });
    expect(stub.calls.availability).toHaveLength(0);
  });

  it('a local-only chain where every step fails is exhausted, in plain words', async () => {
    const t = await ticket({ localOnly: true, steps: [step(1, 'stub')] });
    const r = await walk(t, { engines: [createStubEngine({ availability: 'unavailable' })] });
    expect(r.kind).toBe('exhausted');
    if (r.kind === 'exhausted') expect(r.message).toMatch(/local only/i);
  });
});

describe('walkChain: ticket checks come first', () => {
  it('a tampered ticket is refused and no engine is asked anything', async () => {
    const t = await ticket({
      steps: [step(1, 'stub', 'model-a', { minConfidence: 0.9 }), step(2, 'tenant-hosted')],
    });
    const stub = createStubEngine();
    const r = await walk(
      { ...t, steps: [{ ...t.steps[0]!, minConfidence: 0 }, t.steps[1]!] },
      { engines: [stub] },
    );
    expect(r).toMatchObject({ kind: 'refused', code: 'chain_hash_mismatch' });
    expect(stub.calls.availability).toHaveLength(0);
  });

  it('an expired ticket is refused', async () => {
    const r = await walk(await ticket(), { now: () => NOW + 121_000 });
    expect(r).toMatchObject({ kind: 'refused', code: 'expired' });
  });

  it('a local server is refused on the web page even if a ticket lists it', async () => {
    const t = await ticket({
      steps: [step(1, 'local-server', 'llama3'), step(2, 'tenant-hosted')],
    });
    const r = await walk(t, { engines: [createStubEngine({ engineClass: 'local-server' })] });
    expect(r).toMatchObject({ kind: 'refused', code: 'engine_not_allowed_on_shell' });
  });
});

describe('walkChain: the caller gives up', () => {
  it('stops at once when the caller aborts', async () => {
    const ctl = new AbortController();
    const slow = createStubEngine({ delayMs: 5_000 });
    const t = await ticket({
      steps: [step(1, 'stub', 'model-a', { timeoutMs: 10_000 }), step(2, 'tenant-hosted')],
    });
    const p = walkChain({
      ticket: t,
      engines: [slow],
      input,
      device: WEB,
      now,
      signal: ctl.signal,
    });
    setTimeout(() => ctl.abort(), 20);
    const r = await p;
    expect(r.kind).toBe('cancelled');
  });
});

describe('classifyEngineError', () => {
  it('maps browser errors to reasons', () => {
    expect(classifyEngineError(new DOMException('x', 'AbortError')).reason).toBe('timeout');
    expect(classifyEngineError(new DOMException('x', 'TimeoutError')).reason).toBe('timeout');
    expect(classifyEngineError(new DOMException('x', 'QuotaExceededError')).reason).toBe(
      'out_of_memory',
    );
    expect(classifyEngineError(new RangeError('Array buffer allocation failed')).reason).toBe(
      'out_of_memory',
    );
    expect(classifyEngineError(new Error('WebGPU device lost: out of memory')).reason).toBe(
      'out_of_memory',
    );
    expect(classifyEngineError(new DOMException('x', 'NotSupportedError')).reason).toBe(
      'not_applicable',
    );
    expect(classifyEngineError(new DOMException('x', 'NotAllowedError')).reason).toBe(
      'device_policy_blocked',
    );
    expect(
      classifyEngineError(new EngineError('schema_violation', 'bad json', 'json')).reason,
    ).toBe('schema_violation');
    expect(classifyEngineError('weird')).toEqual({ reason: 'unavailable', detail: 'error' });
  });
});
