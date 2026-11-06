import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@weaveintel/core';
import { lintWorkflow } from './linter.js';

const def = (steps: WorkflowDefinition['steps']): WorkflowDefinition => ({ id: 'w', name: 'w', version: '1', entryStepId: steps[0]!.id, steps });

describe('lintWorkflow — cycles', () => {
  it('refuses a cycle no path can leave', () => {
    const r = lintWorkflow(def([
      { id: 'a', name: 'a', type: 'deterministic', handler: 'noop', next: 'b' },
      { id: 'b', name: 'b', type: 'deterministic', handler: 'noop', next: 'a' },
    ]));
    expect(r.filter((x) => x.severity === 'error').map((x) => x.rule)).toEqual(['circular-reference']);
  });

  it('allows a loop with a way out, as a warning', () => {
    const r = lintWorkflow(def([
      { id: 'ask', name: 'ask', type: 'deterministic', handler: 'noop', next: 'check' },
      { id: 'check', name: 'check', type: 'branch', handler: 'noop', next: ['done', 'ask'] },
      { id: 'done', name: 'done', type: 'deterministic', handler: 'noop' },
    ]));
    expect(r.filter((x) => x.severity === 'error')).toEqual([]);
    expect(r.find((x) => x.rule === 'bounded-cycle')?.stepId).toBe('ask');
  });

  it('counts a switch case and an onError as a way out', () => {
    const viaCase = lintWorkflow(def([
      { id: 's', name: 's', type: 'switch', handler: 'noop', config: { cases: { again: 't', stop: 'end' } } },
      { id: 't', name: 't', type: 'deterministic', handler: 'noop', next: 's' },
      { id: 'end', name: 'end', type: 'deterministic', handler: 'noop' },
    ]));
    expect(viaCase.filter((x) => x.severity === 'error')).toEqual([]);
    const viaError = lintWorkflow(def([
      { id: 'a', name: 'a', type: 'deterministic', handler: 'noop', next: 'b', onError: 'out' },
      { id: 'b', name: 'b', type: 'deterministic', handler: 'noop', next: 'a' },
      { id: 'out', name: 'out', type: 'deterministic', handler: 'noop' },
    ]));
    expect(viaError.filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('a self-loop with no exit is an error; an acyclic graph reports no cycle', () => {
    expect(lintWorkflow(def([{ id: 'a', name: 'a', type: 'deterministic', handler: 'noop', next: 'a' }])).some((x) => x.rule === 'circular-reference')).toBe(true);
    expect(lintWorkflow(def([
      { id: 'a', name: 'a', type: 'deterministic', handler: 'noop', next: 'b' },
      { id: 'b', name: 'b', type: 'deterministic', handler: 'noop' },
    ])).some((x) => x.rule === 'circular-reference' || x.rule === 'bounded-cycle')).toBe(false);
  });
});
