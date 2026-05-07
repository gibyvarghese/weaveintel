/**
 * Unit tests for Phase 2 (DB-driven capability plan) — declarative
 * `prepare()` recipes.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  parsePrepareConfig,
  dbPrepareFromConfig,
  type PrepareConfig,
} from './db-prepare-resolver.js';

describe('parsePrepareConfig', () => {
  it('returns null for null/undefined/empty/{}', () => {
    expect(parsePrepareConfig(null)).toBeNull();
    expect(parsePrepareConfig(undefined)).toBeNull();
    expect(parsePrepareConfig('')).toBeNull();
    expect(parsePrepareConfig('   ')).toBeNull();
    expect(parsePrepareConfig('{}')).toBeNull();
  });

  it('throws on malformed JSON', () => {
    expect(() => parsePrepareConfig('not json')).toThrow(/invalid JSON/);
  });

  it('throws on non-object root', () => {
    expect(() => parsePrepareConfig('[]')).toThrow(/JSON object/);
    expect(() => parsePrepareConfig('"hi"')).toThrow(/JSON object/);
  });

  it('parses literal systemPrompt', () => {
    expect(parsePrepareConfig('{"systemPrompt":"You are X."}')).toEqual({
      systemPrompt: 'You are X.',
    });
  });

  it('parses promptKey systemPrompt', () => {
    expect(
      parsePrepareConfig('{"systemPrompt":{"promptKey":"my.key"}}'),
    ).toEqual({ systemPrompt: { promptKey: 'my.key' } });
  });

  it('parses promptKey + variables', () => {
    expect(
      parsePrepareConfig(
        '{"systemPrompt":{"promptKey":"my.key","variables":{"x":1}}}',
      ),
    ).toEqual({ systemPrompt: { promptKey: 'my.key', variables: { x: 1 } } });
  });

  it('throws on bad systemPrompt shape', () => {
    expect(() => parsePrepareConfig('{"systemPrompt":42}')).toThrow();
    expect(() => parsePrepareConfig('{"systemPrompt":{}}')).toThrow();
  });

  it('parses tools $auto', () => {
    expect(parsePrepareConfig('{"tools":"$auto"}')).toEqual({ tools: '$auto' });
  });

  it('throws on unsupported tools value', () => {
    expect(() => parsePrepareConfig('{"tools":"all"}')).toThrow(/\$auto/);
  });

  it('parses each userGoal variant', () => {
    expect(parsePrepareConfig('{"userGoal":"do it"}')).toEqual({
      userGoal: 'do it',
    });
    expect(parsePrepareConfig('{"userGoal":{"from":"inbound.body"}}')).toEqual({
      userGoal: { from: 'inbound.body' },
    });
    expect(
      parsePrepareConfig('{"userGoal":{"from":"inbound.subject"}}'),
    ).toEqual({ userGoal: { from: 'inbound.subject' } });
    expect(parsePrepareConfig('{"userGoal":{"from":"inbound"}}')).toEqual({
      userGoal: { from: 'inbound' },
    });
    expect(
      parsePrepareConfig('{"userGoal":{"template":"S:{{subject}}"}}'),
    ).toEqual({ userGoal: { template: 'S:{{subject}}' } });
  });

  it('throws on bad userGoal shapes', () => {
    expect(() =>
      parsePrepareConfig('{"userGoal":{"from":"nope"}}'),
    ).toThrow();
    expect(() => parsePrepareConfig('{"userGoal":{}}')).toThrow();
  });

  it('parses memory recipe (forward-compat)', () => {
    expect(
      parsePrepareConfig(
        '{"memory":{"windowMessages":20,"summarizer":"daily"}}',
      ),
    ).toEqual({ memory: { windowMessages: 20, summarizer: 'daily' } });
  });
});

describe('dbPrepareFromConfig', () => {
  const inbound = { subject: 'Hi', body: 'Please review.' };

  it('uses literal systemPrompt + literal userGoal', async () => {
    const { prepare } = dbPrepareFromConfig(
      { systemPrompt: 'You are X.', userGoal: 'do it' },
      {},
    );
    const out = await prepare({ inbound });
    expect(out).toEqual({ systemPrompt: 'You are X.', userGoal: 'do it' });
  });

  it('resolves promptKey via injected dep', async () => {
    const resolvePromptText = vi.fn(async () => 'Resolved body');
    const { prepare } = dbPrepareFromConfig(
      { systemPrompt: { promptKey: 'k', variables: { x: 1 } } },
      { resolvePromptText },
    );
    const out = await prepare({ inbound });
    expect(out.systemPrompt).toBe('Resolved body');
    expect(resolvePromptText).toHaveBeenCalledWith('k', { x: 1 });
  });

  it('throws when promptKey is set but resolver is missing', async () => {
    const { prepare } = dbPrepareFromConfig(
      { systemPrompt: { promptKey: 'k' } },
      {},
    );
    await expect(prepare({ inbound })).rejects.toThrow(/resolvePromptText/);
  });

  it('falls back to defaultSystemPrompt when no recipe systemPrompt', async () => {
    const { prepare } = dbPrepareFromConfig(
      { userGoal: 'go' },
      { defaultSystemPrompt: 'DEFAULT' },
    );
    const out = await prepare({ inbound });
    expect(out.systemPrompt).toBe('DEFAULT');
  });

  it('userGoal: from inbound.body / subject / inbound', async () => {
    const cases: Array<[PrepareConfig['userGoal'], string]> = [
      [{ from: 'inbound.body' }, 'Please review.'],
      [{ from: 'inbound.subject' }, 'Hi'],
      [{ from: 'inbound' }, 'Subject: Hi\n\nPlease review.'],
    ];
    for (const [ug, expected] of cases) {
      const { prepare } = dbPrepareFromConfig(
        { systemPrompt: 'X', userGoal: ug },
        {},
      );
      const out = await prepare({ inbound });
      expect(out.userGoal).toBe(expected);
    }
  });

  it('userGoal: template interpolates subject + body', async () => {
    const { prepare } = dbPrepareFromConfig(
      {
        systemPrompt: 'X',
        userGoal: { template: 'S={{subject}} | B={{body}} | unknown={{x}}' },
      },
      {},
    );
    const out = await prepare({ inbound });
    expect(out.userGoal).toBe('S=Hi | B=Please review. | unknown=');
  });

  it('userGoal default: inbound.body or inbound.subject', async () => {
    const { prepare } = dbPrepareFromConfig({ systemPrompt: 'X' }, {});
    expect((await prepare({ inbound })).userGoal).toBe('Please review.');
    const { prepare: p2 } = dbPrepareFromConfig({ systemPrompt: 'X' }, {});
    expect((await p2({ inbound: { subject: 'OnlySub', body: undefined as unknown as string } })).userGoal).toBe(
      'OnlySub',
    );
    const { prepare: p3 } = dbPrepareFromConfig({ systemPrompt: 'X' }, {});
    expect((await p3({ inbound: null })).userGoal).toBe('');
  });

  it('tools: $auto forwards ctx.tools', async () => {
    const fakeTools = { listTools: () => [], getTool: () => undefined } as never;
    const { prepare } = dbPrepareFromConfig(
      { systemPrompt: 'X', tools: '$auto' },
      { tools: fakeTools },
    );
    const out = await prepare({ inbound });
    expect(out.tools).toBe(fakeTools);
  });

  it('tools omitted: output has no tools field', async () => {
    const { prepare } = dbPrepareFromConfig({ systemPrompt: 'X' }, {});
    const out = await prepare({ inbound });
    expect('tools' in out).toBe(false);
  });
});
