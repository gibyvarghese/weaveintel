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

// ---------------------------------------------------------------------------
// Phase 9 — tools recipe object form + traceTools merge
// ---------------------------------------------------------------------------

describe('parsePrepareConfig: tools object form', () => {
  it('parses { auto: true }', () => {
    expect(parsePrepareConfig('{"tools":{"auto":true}}')).toEqual({
      tools: { auto: true },
    });
  });

  it('parses { traceTools: "$auto" }', () => {
    expect(parsePrepareConfig('{"tools":{"traceTools":"$auto"}}')).toEqual({
      tools: { traceTools: '$auto' },
    });
  });

  it('parses { auto: true, traceTools: "$auto" }', () => {
    expect(
      parsePrepareConfig('{"tools":{"auto":true,"traceTools":"$auto"}}'),
    ).toEqual({ tools: { auto: true, traceTools: '$auto' } });
  });

  it('throws on unknown key inside tools object', () => {
    expect(() => parsePrepareConfig('{"tools":{"weird":true}}')).toThrow(
      /unknown tools key/,
    );
  });

  it('throws on non-boolean tools.auto', () => {
    expect(() => parsePrepareConfig('{"tools":{"auto":"yes"}}')).toThrow(
      /tools\.auto must be boolean/,
    );
  });

  it('throws on traceTools other than "$auto"', () => {
    expect(() => parsePrepareConfig('{"tools":{"traceTools":true}}')).toThrow(
      /traceTools/,
    );
  });
});

describe('dbPrepareFromConfig: tools object form + traceTools merge', () => {
  const inbound = { subject: 's', body: 'b' };

  function makeRegistry(names: string[]) {
    const tools = names.map((n) => ({
      schema: {
        name: n,
        description: `desc ${n}`,
        parameters: { type: 'object' as const, properties: {}, required: [] },
      },
      invoke: async () => ({ content: 'ok' }),
    }));
    return {
      register: () => {},
      unregister: () => {},
      get: (name: string) => tools.find((t) => t.schema.name === name),
      list: () => tools,
      listByTag: () => [],
      toDefinitions: () => [],
    } as never;
  }

  it('{ auto: true } forwards ctx.tools as-is when no trace tools', async () => {
    const fakeTools = makeRegistry(['a', 'b']);
    const { prepare } = dbPrepareFromConfig(
      { systemPrompt: 'X', tools: { auto: true } },
      { tools: fakeTools },
    );
    const out = await prepare({ inbound });
    expect(out.tools).toBe(fakeTools);
  });

  it('{ traceTools: "$auto" } calls factory and uses returned registry', async () => {
    const traceReg = makeRegistry(['live_get_run_timeline']);
    const factory = vi.fn().mockResolvedValue(traceReg);
    const { prepare } = dbPrepareFromConfig(
      { systemPrompt: 'X', tools: { traceTools: '$auto' } },
      {
        traceToolsFactory: factory,
        runId: 'run-1',
        agentId: 'agent-1',
        meshId: 'mesh-1',
      },
    );
    const out = await prepare({ inbound });
    expect(factory).toHaveBeenCalledWith({
      runId: 'run-1',
      agentId: 'agent-1',
      meshId: 'mesh-1',
    });
    expect(out.tools).toBe(traceReg);
  });

  it('merges base + trace registries when both present', async () => {
    const baseReg = makeRegistry(['a', 'b']);
    const traceReg = makeRegistry(['live_get_run_timeline']);
    const { prepare } = dbPrepareFromConfig(
      { systemPrompt: 'X', tools: { auto: true, traceTools: '$auto' } },
      {
        tools: baseReg,
        traceToolsFactory: () => traceReg,
        runId: 'run-1',
      },
    );
    const out = await prepare({ inbound });
    expect(out.tools).not.toBe(baseReg);
    expect(out.tools).not.toBe(traceReg);
    const names = (out.tools as never as { list: () => { schema: { name: string } }[] })
      .list()
      .map((t) => t.schema.name)
      .sort();
    expect(names).toEqual(['a', 'b', 'live_get_run_timeline']);
  });

  it('factory returning null is graceful (no tools when only source)', async () => {
    const { prepare } = dbPrepareFromConfig(
      { systemPrompt: 'X', tools: { traceTools: '$auto' } },
      { traceToolsFactory: () => null, runId: 'run-1' },
    );
    const out = await prepare({ inbound });
    expect('tools' in out).toBe(false);
  });

  it('factory throwing is swallowed (trace tools never load-bearing)', async () => {
    const baseReg = makeRegistry(['a']);
    const { prepare } = dbPrepareFromConfig(
      { systemPrompt: 'X', tools: { auto: true, traceTools: '$auto' } },
      {
        tools: baseReg,
        traceToolsFactory: () => {
          throw new Error('boom');
        },
        runId: 'run-1',
      },
    );
    const out = await prepare({ inbound });
    expect(out.tools).toBe(baseReg);
  });

  it('{ traceTools: "$auto" } without factory dep is a no-op', async () => {
    const { prepare } = dbPrepareFromConfig(
      { systemPrompt: 'X', tools: { traceTools: '$auto' } },
      {},
    );
    const out = await prepare({ inbound });
    expect('tools' in out).toBe(false);
  });
});
