// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { LOCAL_TASKS } from './constants.js';
import { createStubEngine, stubAnswer } from './engines/stub.js';
import { validateTaskOutput } from './validate.js';
import { verifyFileBytes } from './weights.js';
import { sha256Hex } from './canonical.js';

const ctx = (input = {}) => ({ input, maxOutputChars: 200 });

describe('validateTaskOutput', () => {
  it('text.language takes a language tag', () => {
    expect(validateTaskOutput('text.language', { language: 'fr' }, ctx())).toEqual({
      ok: true,
      output: { language: 'fr' },
    });
    expect(validateTaskOutput('text.language', { language: 'pt-BR' }, ctx()).ok).toBe(true);
    expect(validateTaskOutput('text.language', { language: 'French!' }, ctx()).ok).toBe(false);
    expect(validateTaskOutput('text.language', 'fr', ctx()).ok).toBe(false);
  });

  it('text.summary.short is at most 120 words and the output cap', () => {
    expect(
      validateTaskOutput('text.summary.short', { text: ' Printer jams on tray 2. ' }, ctx()),
    ).toEqual({
      ok: true,
      output: { text: 'Printer jams on tray 2.' },
    });
    expect(
      validateTaskOutput(
        'text.summary.short',
        { text: 'word '.repeat(121) },
        { input: {}, maxOutputChars: 10_000 },
      ).ok,
    ).toBe(false);
    expect(validateTaskOutput('text.summary.short', { text: 'x'.repeat(201) }, ctx()).ok).toBe(
      false,
    );
    expect(validateTaskOutput('text.summary.short', { text: '' }, ctx()).ok).toBe(false);
  });

  it('field.suggest must name the asked field and a value from its choices', () => {
    const input = { field: 'priority', choices: ['1', '2', '3'] };
    expect(
      validateTaskOutput(
        'field.suggest',
        { field: 'priority', value: '2', confidence: 0.9 },
        ctx(input),
      ).ok,
    ).toBe(true);
    expect(
      validateTaskOutput('field.suggest', { field: 'urgency', value: '2' }, ctx(input)).ok,
    ).toBe(false);
    expect(
      validateTaskOutput('field.suggest', { field: 'priority', value: '9' }, ctx(input)).ok,
    ).toBe(false);
    expect(
      validateTaskOutput(
        'field.suggest',
        { field: 'priority', value: '2', confidence: 1.5 },
        ctx(input),
      ).ok,
    ).toBe(false);
  });

  it('record.classify must pick from the labels', () => {
    const input = { choices: ['hardware', 'software'] };
    expect(validateTaskOutput('record.classify', { label: 'software' }, ctx(input)).ok).toBe(true);
    expect(validateTaskOutput('record.classify', { label: 'network' }, ctx(input)).ok).toBe(false);
    expect(validateTaskOutput('record.classify', { label: 'software' }, ctx({})).ok).toBe(false);
  });

  it('pii.detect spans must sit inside the input', () => {
    const input = { text: 'Call Ana on 021 555 0101' };
    expect(
      validateTaskOutput(
        'pii.detect',
        { spans: [{ start: 12, end: 24, kind: 'phone' }] },
        ctx(input),
      ).ok,
    ).toBe(true);
    expect(
      validateTaskOutput(
        'pii.detect',
        { spans: [{ start: 12, end: 99, kind: 'phone' }] },
        ctx(input),
      ).ok,
    ).toBe(false);
    expect(
      validateTaskOutput('pii.detect', { spans: [{ start: 5, end: 5, kind: 'name' }] }, ctx(input))
        .ok,
    ).toBe(false);
    expect(validateTaskOutput('pii.detect', { spans: 'none' }, ctx(input)).ok).toBe(false);
  });

  it('text.translate and speech.text are capped text', () => {
    expect(validateTaskOutput('text.translate', { text: 'Hello' }, ctx()).ok).toBe(true);
    expect(validateTaskOutput('speech.text', { text: 'x'.repeat(201) }, ctx()).ok).toBe(false);
  });

  it('an unknown task needs a validator from the host', () => {
    expect(validateTaskOutput('mood.guess', { mood: 'calm' }, ctx()).ok).toBe(false);
    const custom = { 'mood.guess': (o: unknown) => ({ ok: true as const, output: o }) };
    expect(validateTaskOutput('mood.guess', { mood: 'calm' }, ctx(), custom).ok).toBe(true);
  });

  it("the stub's default answer passes the check for every known task", async () => {
    const stub = createStubEngine();
    const input = {
      text: 'Call Ana on 021 555 0101',
      field: 'priority',
      choices: ['1', '2'],
      targetLanguage: 'en',
    };
    for (const task of LOCAL_TASKS) {
      const signal = new AbortController().signal;
      const run = await stub.run({
        task,
        modelKey: 'm',
        input,
        signal,
        files: [],
        maxOutputChars: 4000,
        allowDownload: false,
      });
      expect(
        validateTaskOutput(task, run.output, { input, maxOutputChars: 4000 }),
        task,
      ).toMatchObject({ ok: true });
      expect(
        stubAnswer({
          task,
          modelKey: 'm',
          input,
          signal,
          files: [],
          maxOutputChars: 4000,
          allowDownload: false,
        }),
      ).toEqual(run);
    }
  });
});

describe('verifyFileBytes', () => {
  it('accepts the pinned bytes and refuses a wrong size or a wrong hash', async () => {
    const bytes = new TextEncoder().encode('weights');
    const sha256 = await sha256Hex(bytes);
    expect(
      await verifyFileBytes({ name: 'm.onnx', sha256, bytes: bytes.byteLength }, bytes),
    ).toEqual({ ok: true });
    expect(
      await verifyFileBytes(
        { name: 'm.onnx', sha256: sha256.toUpperCase(), bytes: bytes.byteLength },
        bytes.buffer,
      ),
    ).toEqual({ ok: true });
    expect(await verifyFileBytes({ name: 'm.onnx', sha256, bytes: 8 }, bytes)).toEqual({
      ok: false,
      reason: 'size_mismatch',
      name: 'm.onnx',
    });
    const other = new TextEncoder().encode('weightz');
    expect(await verifyFileBytes({ name: 'm.onnx', sha256, bytes: 7 }, other)).toEqual({
      ok: false,
      reason: 'hash_mismatch',
      name: 'm.onnx',
    });
  });
});
