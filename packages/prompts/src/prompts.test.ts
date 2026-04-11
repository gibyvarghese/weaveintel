/**
 * @weaveintel/prompts — Unit tests
 */
import { describe, it, expect } from 'vitest';
import {
  createTemplate,
  extractVariables,
  InMemoryPromptRegistry,
  PromptResolver,
  InMemoryExperimentStore,
  InstructionBundleBuilder,
  composeInstructions,
  createInstructionBundle,
} from '../src/index.js';
import type { PromptDefinition, PromptVersion, PromptExperiment } from '@weaveintel/core';

// ─── Template ────────────────────────────────────────────────

describe('createTemplate', () => {
  it('renders a simple template', () => {
    const tpl = createTemplate({ name: 'test', template: 'Hello {{name}}!' });
    expect(tpl.render({ name: 'World' })).toBe('Hello World!');
  });

  it('auto-detects variables', () => {
    const tpl = createTemplate({ name: 'test', template: '{{a}} and {{b}}' });
    expect(tpl.variables).toHaveLength(2);
    expect(tpl.variables.map(v => v.name)).toEqual(['a', 'b']);
  });

  it('throws on missing required variable', () => {
    const tpl = createTemplate({ name: 'test', template: 'Hello {{name}}!' });
    expect(() => tpl.render({})).toThrow('Missing required variable "name"');
  });

  it('uses default value when provided', () => {
    const tpl = createTemplate({
      name: 'test',
      template: 'Hello {{name}}!',
      variables: [{ name: 'name', type: 'string', required: false, defaultValue: 'default' }],
    });
    expect(tpl.render({})).toBe('Hello default!');
  });

  it('handles multiple occurrences of same variable', () => {
    const tpl = createTemplate({ name: 'test', template: '{{x}} + {{x}} = 2{{x}}' });
    expect(tpl.render({ x: 'a' })).toBe('a + a = 2a');
  });

  it('handles template with no variables', () => {
    const tpl = createTemplate({ name: 'test', template: 'No vars here' });
    expect(tpl.render({})).toBe('No vars here');
    expect(tpl.variables).toHaveLength(0);
  });

  it('coerces numbers to strings', () => {
    const tpl = createTemplate({ name: 'test', template: 'Count: {{n}}' });
    expect(tpl.render({ n: 42 })).toBe('Count: 42');
  });
});

describe('extractVariables', () => {
  it('extracts unique variable names', () => {
    const vars = extractVariables('{{a}} {{b}} {{a}}');
    expect(vars).toEqual(['a', 'b']);
  });

  it('returns empty array for no variables', () => {
    expect(extractVariables('plain text')).toEqual([]);
  });
});

// ─── Registry ────────────────────────────────────────────────

describe('InMemoryPromptRegistry', () => {
  const makeDef = (id: string): PromptDefinition => ({
    id, name: id, currentVersion: '1.0',
  });

  const makeVer = (promptId: string, version: string, template: string): PromptVersion => ({
    id: `${promptId}-${version}`, promptId, version, template, variables: [], createdAt: new Date().toISOString(),
  });

  it('registers and retrieves a prompt', async () => {
    const reg = new InMemoryPromptRegistry();
    await reg.register(makeDef('p1'), makeVer('p1', '1.0', 'Hello'));
    const ver = await reg.get('p1');
    expect(ver).not.toBeNull();
    expect(ver!.template).toBe('Hello');
  });

  it('returns null for unknown prompt', async () => {
    const reg = new InMemoryPromptRegistry();
    expect(await reg.get('unknown')).toBeNull();
  });

  it('lists prompts by category', async () => {
    const reg = new InMemoryPromptRegistry();
    await reg.register({ ...makeDef('p1'), category: 'eng' }, makeVer('p1', '1.0', 'A'));
    await reg.register({ ...makeDef('p2'), category: 'marketing' }, makeVer('p2', '1.0', 'B'));
    const eng = await reg.list({ category: 'eng' });
    expect(eng).toHaveLength(1);
    expect(eng[0]!.id).toBe('p1');
  });

  it('resolves with variable substitution', async () => {
    const reg = new InMemoryPromptRegistry();
    const ver = makeVer('p1', '1.0', 'Hello {{name}}!');
    ver.variables = [{ name: 'name', type: 'string', required: true }];
    await reg.register(makeDef('p1'), ver);
    const resolved = await reg.resolve('p1', { name: 'Alice' });
    expect(resolved).toBe('Hello Alice!');
  });

  it('deletes a prompt', async () => {
    const reg = new InMemoryPromptRegistry();
    await reg.register(makeDef('p1'), makeVer('p1', '1.0', 'A'));
    await reg.delete('p1');
    expect(await reg.get('p1')).toBeNull();
  });

  it('gets specific version', async () => {
    const reg = new InMemoryPromptRegistry();
    await reg.register(makeDef('p1'), makeVer('p1', '1.0', 'V1'));
    await reg.register(makeDef('p1'), makeVer('p1', '2.0', 'V2'));
    const v1 = await reg.get('p1', '1.0');
    expect(v1!.template).toBe('V1');
    const v2 = await reg.get('p1', '2.0');
    expect(v2!.template).toBe('V2');
  });

  it('get returns latest when no version specified', async () => {
    const reg = new InMemoryPromptRegistry();
    await reg.register(makeDef('p1'), makeVer('p1', '1.0', 'Old'));
    await reg.register(makeDef('p1'), makeVer('p1', '2.0', 'New'));
    const latest = await reg.get('p1');
    expect(latest!.template).toBe('New');
  });
});

// ─── Resolver ────────────────────────────────────────────────

describe('PromptResolver', () => {
  it('resolves default version', async () => {
    const store = {
      getVersion: async (_id: string, _v?: string) => ({
        id: 'v1', promptId: 'p1', version: '1.0', template: 'Default', variables: [], createdAt: '',
      }),
    };
    const resolver = new PromptResolver(store);
    const ver = await resolver.resolve('p1', {});
    expect(ver.template).toBe('Default');
  });

  it('resolves from experiment when active', async () => {
    const store = {
      getVersion: async (_id: string, ver?: string) => {
        if (ver === 'exp-v') return { id: 'exp-v', promptId: 'p1', version: 'exp-v', template: 'Experiment', variables: [], createdAt: '' };
        return { id: 'def', promptId: 'p1', version: '1.0', template: 'Default', variables: [], createdAt: '' };
      },
    };
    const experiments = new InMemoryExperimentStore();
    experiments.addExperiment({
      id: 'exp1', name: 'Test', promptId: 'p1', status: 'active',
      variants: [{ id: 'var1', promptId: 'p1', versionId: 'exp-v', weight: 1, label: 'A' }],
    });
    const resolver = new PromptResolver(store, experiments);
    const ver = await resolver.resolve('p1', { experimentId: 'exp1' });
    expect(ver.template).toBe('Experiment');
  });

  it('throws when prompt not found', async () => {
    const store = { getVersion: async () => null };
    const resolver = new PromptResolver(store);
    await expect(resolver.resolve('missing', {})).rejects.toThrow('not found');
  });
});

// ─── Experiments ─────────────────────────────────────────────

describe('InMemoryExperimentStore', () => {
  it('picks variant from active experiment', async () => {
    const store = new InMemoryExperimentStore();
    store.addExperiment({
      id: 'exp1', name: 'Test', promptId: 'p1', status: 'active',
      variants: [{ id: 'v1', promptId: 'p1', versionId: 'ver1', weight: 1, label: 'A' }],
    });
    const variant = await store.pickVariant('exp1');
    expect(variant).not.toBeNull();
    expect(variant!.id).toBe('v1');
  });

  it('returns null for draft experiment', async () => {
    const store = new InMemoryExperimentStore();
    store.addExperiment({
      id: 'exp1', name: 'Test', promptId: 'p1', status: 'draft',
      variants: [{ id: 'v1', promptId: 'p1', versionId: 'ver1', weight: 1, label: 'A' }],
    });
    expect(await store.pickVariant('exp1')).toBeNull();
  });

  it('records impressions and scores', async () => {
    const store = new InMemoryExperimentStore();
    store.addExperiment({
      id: 'exp1', name: 'Test', promptId: 'p1', status: 'active',
      variants: [{ id: 'v1', promptId: 'p1', versionId: 'ver1', weight: 1, label: 'A' }],
    });
    await store.recordImpression('exp1', 'v1');
    await store.recordScore('exp1', 'v1', 0.8);
    const exp = await store.getExperiment('exp1');
    expect(exp!.results!['v1']!.impressions).toBeGreaterThan(0);
  });

  it('returns null for unknown experiment', async () => {
    const store = new InMemoryExperimentStore();
    expect(await store.pickVariant('unknown')).toBeNull();
  });
});

// ─── Instructions ────────────────────────────────────────────

describe('InstructionBundleBuilder', () => {
  it('builds and composes a full bundle', () => {
    const bundle = createInstructionBundle('ib-1', 'Test')
      .system('You are a helpful assistant.')
      .task('Answer questions.')
      .formatting('Use markdown.')
      .guardrails('No harmful content.')
      .examples('Q: Hello A: Hi!', 'Q: Bye A: Goodbye!')
      .build();

    expect(bundle.id).toBe('ib-1');
    expect(bundle.system).toBe('You are a helpful assistant.');
    expect(bundle.task).toBe('Answer questions.');
    expect(bundle.examples).toHaveLength(2);

    const composed = composeInstructions(bundle);
    expect(composed).toContain('You are a helpful assistant.');
    expect(composed).toContain('## Task');
    expect(composed).toContain('## Formatting');
    expect(composed).toContain('## Guardrails');
    expect(composed).toContain('## Examples');
  });

  it('composes minimal bundle', () => {
    const bundle = new InstructionBundleBuilder('ib-2', 'Min').system('System only').build();
    const composed = composeInstructions(bundle);
    expect(composed).toBe('System only');
  });
});
