/**
 * @weaveintel/guardrails — resolver.test.ts  (W6)
 */
import { describe, it, expect } from 'vitest';
import type { Guardrail } from '@weaveintel/core';
import { createGuardrailResolver } from './resolver.js';

const g = (id: string, overrides: Partial<Guardrail> = {}): Guardrail => ({
  id,
  name: id,
  type: 'blocklist',
  stage: 'pre-execution',
  enabled: true,
  config: { words: [id] },
  ...overrides,
});

describe('InMemoryGuardrailResolver', () => {
  it('returns global guardrails when no tenant/persona is specified', async () => {
    const resolver = createGuardrailResolver()
      .setGlobal([g('global-1'), g('global-2')]);
    const result = await resolver.resolve({ stage: 'pre-execution' });
    expect(result.map(r => r.id)).toEqual(expect.arrayContaining(['global-1', 'global-2']));
  });

  it('merges tenant guardrails over globals (same ID wins for tenant)', async () => {
    const resolver = createGuardrailResolver()
      .setGlobal([g('shared', { config: { words: ['global-value'] } })])
      .setTenant('tenant-a', [g('shared', { config: { words: ['tenant-value'] } })]);

    const result = await resolver.resolve({ tenantId: 'tenant-a', stage: 'pre-execution' });
    const shared = result.find(r => r.id === 'shared');
    expect(shared?.config['words']).toEqual(['tenant-value']);
  });

  it('tenant A and tenant B get different effective sets', async () => {
    const resolver = createGuardrailResolver()
      .setGlobal([g('base')])
      .setTenant('a', [g('a-only')])
      .setTenant('b', [g('b-only')]);

    const a = await resolver.resolve({ tenantId: 'a', stage: 'pre-execution' });
    const b = await resolver.resolve({ tenantId: 'b', stage: 'pre-execution' });

    expect(a.some(r => r.id === 'a-only')).toBe(true);
    expect(a.some(r => r.id === 'b-only')).toBe(false);
    expect(b.some(r => r.id === 'b-only')).toBe(true);
    expect(b.some(r => r.id === 'a-only')).toBe(false);
  });

  it('persona layer overrides tenant layer', async () => {
    const resolver = createGuardrailResolver()
      .setGlobal([g('shared', { config: { words: ['global'] } })])
      .setTenant('t', [g('shared', { config: { words: ['tenant'] } })])
      .setPersona('analyst', [g('shared', { config: { words: ['persona'] } })]);

    const result = await resolver.resolve({ tenantId: 't', persona: 'analyst', stage: 'pre-execution' });
    const shared = result.find(r => r.id === 'shared');
    expect(shared?.config['words']).toEqual(['persona']);
  });

  it('disabled guardrails are excluded from results', async () => {
    const resolver = createGuardrailResolver()
      .setGlobal([g('enabled'), g('disabled', { enabled: false })]);

    const result = await resolver.resolve({ stage: 'pre-execution' });
    expect(result.some(r => r.id === 'disabled')).toBe(false);
    expect(result.some(r => r.id === 'enabled')).toBe(true);
  });

  it('absent resolver (no config) returns empty — existing callers unaffected', async () => {
    const resolver = createGuardrailResolver(); // no global set
    const result = await resolver.resolve({ stage: 'pre-execution' });
    expect(result).toHaveLength(0);
  });
});
