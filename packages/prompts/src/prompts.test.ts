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
  createPromptDefinitionFromRecord,
  createPromptVersionFromRecord,
  renderPromptRecord,
  renderPromptVersion,
  resolvePromptRecordForExecution,
  stringifyPromptVariables,
} from '../src/index.js';
import type { PromptDefinition, PromptExperiment, PromptVersion, TemplatePromptVersion } from '@weaveintel/core';

type PromptVersionStoreLike = {
  getVersion(promptId: string, version?: string): Promise<PromptVersion | null>;
};

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
    id, key: id, name: id, currentVersion: '1.0', kind: 'template', status: 'published',
  });

  const makeVer = (promptId: string, version: string, template: string): TemplatePromptVersion => ({
    id: `${promptId}-${version}`, promptId, version, kind: 'template', template, variables: [], createdAt: new Date().toISOString(),
  });

  it('registers and retrieves a prompt', async () => {
    const reg = new InMemoryPromptRegistry();
    await reg.register(makeDef('p1'), makeVer('p1', '1.0', 'Hello'));
    const ver = await reg.get('p1');
    expect(ver).not.toBeNull();
    expect(renderPromptVersion(ver!, {})).toBe('Hello');
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
    expect(renderPromptVersion(v1!, {})).toBe('V1');
    const v2 = await reg.get('p1', '2.0');
    expect(renderPromptVersion(v2!, {})).toBe('V2');
  });

  it('get returns latest when no version specified', async () => {
    const reg = new InMemoryPromptRegistry();
    await reg.register(makeDef('p1'), makeVer('p1', '1.0', 'Old'));
    await reg.register(makeDef('p1'), makeVer('p1', '2.0', 'New'));
    const latest = await reg.get('p1');
    expect(renderPromptVersion(latest!, {})).toBe('New');
  });
});

// ─── Resolver ────────────────────────────────────────────────

describe('PromptResolver', () => {
  it('resolves default version', async () => {
    const store: PromptVersionStoreLike = {
      getVersion: async (_id: string, _v?: string) => ({
        id: 'v1', promptId: 'p1', version: '1.0', kind: 'template', template: 'Default', variables: [], createdAt: '',
      }),
    };
    const resolver = new PromptResolver(store);
    const ver = await resolver.resolve('p1', {});
    expect(renderPromptVersion(ver, {})).toBe('Default');
  });

  it('resolves from experiment when active', async () => {
    const store: PromptVersionStoreLike = {
      getVersion: async (_id: string, ver?: string) => {
        if (ver === 'exp-v') return { id: 'exp-v', promptId: 'p1', version: 'exp-v', kind: 'template', template: 'Experiment', variables: [], createdAt: '' };
        return { id: 'def', promptId: 'p1', version: '1.0', kind: 'template', template: 'Default', variables: [], createdAt: '' };
      },
    };
    const experiments = new InMemoryExperimentStore();
    experiments.addExperiment({
      id: 'exp1', name: 'Test', promptId: 'p1', status: 'active',
      variants: [{ id: 'var1', promptId: 'p1', versionId: 'exp-v', weight: 1, label: 'A' }],
    });
    const resolver = new PromptResolver(store, experiments);
    const ver = await resolver.resolve('p1', { experimentId: 'exp1' });
    expect(renderPromptVersion(ver, {})).toBe('Experiment');
  });

  it('throws when prompt not found', async () => {
    const store = { getVersion: async () => null };
    const resolver = new PromptResolver(store);
    await expect(resolver.resolve('missing', {})).rejects.toThrow('not found');
  });

  it('builds prompt objects from database-shaped records', () => {
    const record = {
      id: 'prompt-1',
      key: 'support.reply',
      name: 'Support Reply',
      description: 'Detailed support reply prompt for handling customer tickets.',
      category: 'support',
      template: 'Hello {{name}}',
      variables: stringifyPromptVariables([{ name: 'name', type: 'string', required: true }]),
      version: '2.0',
      status: 'published',
      prompt_type: 'template',
      owner: 'support-team',
      tags: JSON.stringify(['support', 'email']),
      model_compatibility: JSON.stringify({ providers: ['openai'] }),
      execution_defaults: JSON.stringify({ strategy: 'singlePass', explanationStyle: 'standard' }),
      created_at: '2026-04-19T00:00:00Z',
      updated_at: '2026-04-19T01:00:00Z',
    };

    const def = createPromptDefinitionFromRecord(record);
    const ver = createPromptVersionFromRecord(record);

    expect(def.key).toBe('support.reply');
    expect(def.status).toBe('published');
    expect(ver.kind).toBe('template');
    expect(renderPromptVersion(ver, { name: 'Alice' })).toBe('Hello Alice');
  });

  it('renders prompt records with lifecycle hooks and evaluations', () => {
    const events: string[] = [];
    const result = renderPromptRecord({
      id: 'prompt-2',
      key: 'ops.summary',
      name: 'Ops Summary',
      description: 'Create an operational summary from incident notes for shift handoff.',
      prompt_type: 'template',
      template: 'Summary for {{team}}',
      variables: stringifyPromptVariables([{ name: 'team', type: 'string', required: true }]),
      version: '1.0',
      status: 'published',
    }, { team: 'SRE' }, {
      hooks: {
        onStart: () => events.push('start'),
        onSuccess: () => events.push('success'),
      },
      evaluations: [
        {
          id: 'non_empty',
          description: 'Prompt output should be non-empty',
          evaluate: ({ content }) => ({ passed: content.length > 0, score: 1 }),
        },
      ],
    });

    expect(result.content).toBe('Summary for SRE');
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0]!.passed).toBe(true);
    expect(events).toEqual(['start', 'success']);
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

// ─── Phase 5: Safe version resolution ───────────────────────

describe('resolvePromptRecordForExecution', () => {
  const baseRecord = {
    id: 'prompt-abc',
    key: 'support.reply',
    name: 'Support Reply',
    template: 'Base template',
    version: '1.0',
    status: 'published',
  };

  it('prefers requested version when present', () => {
    const resolved = resolvePromptRecordForExecution({
      prompt: baseRecord,
      versions: [
        { id: 'v1', prompt_id: 'prompt-abc', version: '1.0', status: 'published', template: 'v1', enabled: 1 },
        { id: 'v2', prompt_id: 'prompt-abc', version: '2.0', status: 'published', template: 'v2', enabled: 1 },
      ],
      options: { requestedVersion: '2.0' },
    });

    expect(resolved.record.template).toBe('v2');
    expect(resolved.meta.selectedBy).toBe('requested_version');
    expect(resolved.meta.resolvedVersion).toBe('2.0');
  });

  it('uses active experiment variant deterministically', () => {
    const resolvedA = resolvePromptRecordForExecution({
      prompt: baseRecord,
      versions: [
        { id: 'v1', prompt_id: 'prompt-abc', version: '1.0', status: 'published', template: 'control', enabled: 1 },
        { id: 'v2', prompt_id: 'prompt-abc', version: '1.1', status: 'published', template: 'candidate', enabled: 1 },
      ],
      experiments: [
        {
          id: 'exp-1',
          prompt_id: 'prompt-abc',
          status: 'active',
          enabled: 1,
          variants_json: JSON.stringify([
            { version: '1.0', weight: 50, label: 'control' },
            { version: '1.1', weight: 50, label: 'candidate' },
          ]),
        },
      ],
      options: { assignmentKey: 'tenant-42' },
    });

    const resolvedB = resolvePromptRecordForExecution({
      prompt: baseRecord,
      versions: [
        { id: 'v1', prompt_id: 'prompt-abc', version: '1.0', status: 'published', template: 'control', enabled: 1 },
        { id: 'v2', prompt_id: 'prompt-abc', version: '1.1', status: 'published', template: 'candidate', enabled: 1 },
      ],
      experiments: [
        {
          id: 'exp-1',
          prompt_id: 'prompt-abc',
          status: 'active',
          enabled: 1,
          variants_json: JSON.stringify([
            { version: '1.0', weight: 50, label: 'control' },
            { version: '1.1', weight: 50, label: 'candidate' },
          ]),
        },
      ],
      options: { assignmentKey: 'tenant-42' },
    });

    expect(resolvedA.meta.selectedBy).toBe('experiment');
    expect(resolvedA.record.template).toBe(resolvedB.record.template);
  });

  it('falls back to active published version then latest published', () => {
    const active = resolvePromptRecordForExecution({
      prompt: baseRecord,
      versions: [
        { id: 'v1', prompt_id: 'prompt-abc', version: '1.0', status: 'published', template: 'v1', enabled: 1 },
        { id: 'v2', prompt_id: 'prompt-abc', version: '2.0', status: 'published', template: 'v2', is_active: 1, enabled: 1 },
      ],
    });
    expect(active.record.template).toBe('v2');
    expect(active.meta.selectedBy).toBe('active_flag');

    const latest = resolvePromptRecordForExecution({
      prompt: baseRecord,
      versions: [
        { id: 'v1', prompt_id: 'prompt-abc', version: '1.2', status: 'published', template: 'v1.2', enabled: 1 },
        { id: 'v2', prompt_id: 'prompt-abc', version: '1.10', status: 'published', template: 'v1.10', enabled: 1 },
      ],
    });
    expect(latest.record.template).toBe('v1.10');
    expect(latest.meta.selectedBy).toBe('latest_published');
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
